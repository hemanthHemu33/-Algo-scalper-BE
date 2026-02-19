const { DateTime } = require("luxon");
const { emaSeries } = require("./ema");
const { atr, maxHigh, minLow, rollingVWAP } = require("./utils");
const { getMinCandlesForRegime } = require("./minCandles");

function parseList(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function detectRegime({ candles, env, now = new Date() }) {
  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  const minCandles = getMinCandlesForRegime(env);
  if (!candles || candles.length < minCandles) {
    return { regime: "UNKNOWN", meta: { reason: "INSUFFICIENT_CANDLES" } };
  }

  // ---- OPEN window ----
  const dt = DateTime.fromJSDate(now, { zone: tz });
  const open = DateTime.fromFormat(env.MARKET_OPEN || "09:15", "HH:mm", {
    zone: tz,
  }).set({ year: dt.year, month: dt.month, day: dt.day });

  const openWinMin = Number(env.SELECTOR_OPEN_WINDOW_MIN ?? 20);
  const minsFromOpen = open.isValid ? dt.diff(open, "minutes").minutes : 9999;

  if (minsFromOpen >= 0 && minsFromOpen <= openWinMin) {
    return { regime: "OPEN", meta: { minsFromOpen } };
  }

  // ---- Trend vs Range ----
  const fast = Number(env.SELECTOR_FAST_EMA ?? 9);
  const slow = Number(env.SELECTOR_SLOW_EMA ?? 21);
  const lookback = Number(env.SELECTOR_RANGE_LOOKBACK ?? 30);
  const atrPeriod = Number(env.SELECTOR_ATR_PERIOD ?? 14);

  const closes = candles.map((c) => Number(c.close)).filter(Number.isFinite);
  if (closes.length < slow + 5) {
    return { regime: "UNKNOWN", meta: { reason: "BAD_CLOSES" } };
  }

  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);

  const cur = closes[closes.length - 1];
  const emaDiff = Math.abs((ef[ef.length - 1] || 0) - (es[es.length - 1] || 0));

  const atrVal = atr(candles, atrPeriod) || cur * 0.001;
  const diffInAtr = atrVal > 0 ? emaDiff / atrVal : 0;

  const hi = maxHigh(candles, lookback);
  const lo = minLow(candles, lookback);
  const rangePct = cur > 0 ? (hi - lo) / cur : 0;

  const vwap = rollingVWAP(candles, Number(env.SELECTOR_VWAP_LOOKBACK ?? 120));
  const vwapDist = cur > 0 ? Math.abs(cur - vwap) / cur : 0;

  const trendDiffAtr = Number(env.SELECTOR_TREND_DIFF_ATR ?? 0.6);
  const rangePctMax = Number(env.SELECTOR_RANGE_PCT_MAX ?? 0.012);
  const rangeDiffAtrMax = Number(env.SELECTOR_RANGE_DIFF_ATR_MAX ?? 0.25);

  if (diffInAtr >= trendDiffAtr) {
    return {
      regime: "TREND",
      meta: { diffInAtr, rangePct, vwapDist, minsFromOpen },
    };
  }

  if (rangePct <= rangePctMax && diffInAtr <= rangeDiffAtrMax) {
    return {
      regime: "RANGE",
      meta: { diffInAtr, rangePct, vwapDist, minsFromOpen },
    };
  }

  const fallback = diffInAtr > 0.35 ? "TREND" : "RANGE";
  return {
    regime: fallback,
    meta: { diffInAtr, rangePct, vwapDist, minsFromOpen },
  };
}

function pickStrategies({ candles, env, now = new Date() }) {
  const always = parseList(
    env.STRATEGIES_ALWAYS || env.STRATEGIES || "ema_cross"
  );
  const det = detectRegime({ candles, env, now });

  const trend = parseList(env.STRATEGIES_TREND);
  const range = parseList(env.STRATEGIES_RANGE);
  const open = parseList(env.STRATEGIES_OPEN);

  let bucket = [];
  if (det.regime === "OPEN") bucket = open;
  else if (det.regime === "TREND") bucket = trend;
  else if (det.regime === "RANGE") bucket = range;

  const strategyIds = uniq([...always, ...bucket]);
  return { ...det, strategyIds };
}

module.exports = { detectRegime, pickStrategies };
