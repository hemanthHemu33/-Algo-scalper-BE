const { env } = require("../config");
const { getRecentCandles } = require("../market/candleStore");
const { enabledStrategyIds, runStrategy } = require("./registry");
const { pickStrategies } = require("./selector");
const { getMinCandlesForSignal } = require("./minCandles");
const { telemetry } = require("../telemetry/signalTelemetry");

function enabledIntervals() {
  return String(env.SIGNAL_INTERVALS || "1")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function mergeCandlesByTs(primary, secondary) {
  const map = new Map();
  for (const candle of primary || []) {
    const ts = candle?.ts ? new Date(candle.ts).getTime() : null;
    if (Number.isFinite(ts)) map.set(ts, candle);
  }
  for (const candle of secondary || []) {
    const ts = candle?.ts ? new Date(candle.ts).getTime() : null;
    if (Number.isFinite(ts)) map.set(ts, candle);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1]);
}

async function evaluateOnCandleClose({
  instrument_token,
  intervalMin,
  candles,
}) {
  const allow = enabledIntervals();
  if (!allow.includes(Number(intervalMin))) return null;

  // We keep a generous limit so strategies have enough context.
  const minCandles = getMinCandlesForSignal(env, intervalMin);
  let series = candles;
  if (!series || series.length < minCandles) {
    const fetched = await getRecentCandles(instrument_token, intervalMin, 400);
    if (series && series.length) {
      series = mergeCandlesByTs(fetched, series);
    } else {
      series = fetched;
    }
  }
  if (!series || series.length < minCandles) return null;

  const last = series[series.length - 1];
  return evaluateFromCandles({
    candles: series,
    last,
    instrument_token,
    intervalMin,
    stage: "close",
  });
}

async function evaluateOnCandleTick({
  instrument_token,
  intervalMin,
  liveCandle,
  candles,
}) {
  const allow = enabledIntervals();
  if (!allow.includes(Number(intervalMin))) return null;

  const minCandles = getMinCandlesForSignal(env, intervalMin);
  let series = candles;
  if (!series || series.length < minCandles) {
    const fetched = await getRecentCandles(instrument_token, intervalMin, 400);
    if (series && series.length) {
      series = mergeCandlesByTs(fetched, series);
    } else {
      series = fetched;
    }
  }
  if (!series || series.length < minCandles) return null;

  const live = liveCandle || null;
  if (!live || !live.ts) return null;

  const last = series[series.length - 1];
  const lastTs = last?.ts ? new Date(last.ts).getTime() : null;
  const liveTs = new Date(live.ts).getTime();

  let merged = series.slice();
  if (lastTs != null && liveTs === lastTs) {
    merged[merged.length - 1] = live;
  } else {
    merged.push(live);
  }

  return evaluateFromCandles({
    candles: merged,
    last: live,
    instrument_token,
    intervalMin,
    stage: "tick",
  });
}

function evaluateFromCandles({
  candles,
  last,
  instrument_token,
  intervalMin,
  stage,
}) {
  let ids = enabledStrategyIds();
  if (!ids.length) return null;

  let sel = null;
  if (String(env.STRATEGY_SELECTOR_ENABLED || "false") === "true") {
    sel = pickStrategies({ candles, env, now: new Date() });
    if (sel?.strategyIds?.length) ids = sel.strategyIds;
  }

  const signals = [];
  for (const id of ids) {
    const res = runStrategy(id, candles, { intervalMin });
    if (res) {
      signals.push(res);

      // Observability: record every candidate signal (even if not selected)
      telemetry.recordCandidate({
        strategyId: res.strategyId,
        strategyStyle: res.strategyStyle,
        side: res.side,
        confidence: res.confidence,
        instrument_token: Number(instrument_token),
        intervalMin: Number(intervalMin),
        ts: last?.ts,
        stage,
      });
    }
  }
  if (!signals.length) return null;

  // Pick the highest-confidence signal (tie-breaker: earliest in STRATEGIES list)
  signals.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  const best = signals[0];

  // Reject synthetic candles if requested
  if (String(env.ALLOW_SYNTHETIC_SIGNALS || "false") !== "true") {
    if (last?.source && last.source !== "live") return null;
    if (last?.synthetic) return null;
  }

  // Observability: mark the selected candidate (useful to compare selected vs blocked later)
  telemetry.recordDecision({
    signal: {
      strategyId: best.strategyId,
      strategyStyle: best.strategyStyle,
      side: best.side,
      intervalMin: Number(intervalMin),
    },
    token: Number(instrument_token),
    outcome: "SELECTED",
    stage: stage === "tick" ? "selector_tick" : "selector",
    reason: best.reason,
    meta: {
      confidence: Number(best.confidence || 0),
      regime: sel?.regime || null,
    },
  });

  return {
    strategyId: best.strategyId || env.STRATEGY_ID,
    strategyStyle: best.strategyStyle || null,
    strategyFamily: best.strategyFamily || null,
    confidence: Number(best.confidence || 0),
    instrument_token: Number(instrument_token),
    intervalMin: Number(intervalMin),
    regime: sel?.regime || null,
    regimeMeta: sel?.meta || null,
    side: best.side,
    reason: best.reason,
    candle: {
      interval_min: Number(intervalMin),
      ts: last.ts,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      volume: last.volume,
      source: last.source,
      synthetic: last.synthetic,
    },
    ts: last.ts,
    stage,
  };
}

module.exports = { evaluateOnCandleClose, evaluateOnCandleTick };
