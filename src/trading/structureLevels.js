const { DateTime } = require("luxon");
const {
  getSessionForDateTime,
  buildBoundsForToday,
} = require("../market/marketCalendar");

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function candleTs(c) {
  if (!c) return null;
  for (const key of ["timestamp", "ts", "date", "time"]) {
    if (c[key] == null) continue;
    const raw = c[key];
    const t = typeof raw === "number" ? Number(raw) : new Date(raw).getTime();
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function hiLo(rows) {
  const highs = rows.map((r) => toNum(r.high)).filter(Number.isFinite);
  const lows = rows.map((r) => toNum(r.low)).filter(Number.isFinite);
  if (!highs.length || !lows.length) return { high: null, low: null };
  return { high: Math.max(...highs), low: Math.min(...lows) };
}

function computeVwap(rows) {
  let pv = 0;
  let volSum = 0;
  for (const c of rows) {
    const h = toNum(c.high);
    const l = toNum(c.low);
    const cl = toNum(c.close);
    const v = toNum(c.volume);
    if (!(Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(cl))) continue;
    if (!(Number.isFinite(v) && v > 0)) continue;
    const typical = (h + l + cl) / 3;
    pv += typical * v;
    volSum += v;
  }
  return volSum > 0 ? pv / volSum : null;
}

function computeSwingLevels(rows, look = 2) {
  if (!Array.isArray(rows) || rows.length < look * 2 + 3) return { swingHL: null, swingLH: null };

  const pivotLows = [];
  const pivotHighs = [];
  for (let i = look; i < rows.length - look; i += 1) {
    const curH = toNum(rows[i].high);
    const curL = toNum(rows[i].low);
    if (!Number.isFinite(curH) || !Number.isFinite(curL)) continue;
    let lowPivot = true;
    let highPivot = true;
    for (let k = i - look; k <= i + look; k += 1) {
      if (k === i) continue;
      const h = toNum(rows[k].high);
      const l = toNum(rows[k].low);
      if (Number.isFinite(l) && curL >= l) lowPivot = false;
      if (Number.isFinite(h) && curH <= h) highPivot = false;
      if (!lowPivot && !highPivot) break;
    }
    if (lowPivot) pivotLows.push(curL);
    if (highPivot) pivotHighs.push(curH);
  }

  let swingHL = null;
  for (let i = pivotLows.length - 1; i > 0; i -= 1) {
    if (pivotLows[i] > pivotLows[i - 1]) {
      swingHL = pivotLows[i];
      break;
    }
  }
  let swingLH = null;
  for (let i = pivotHighs.length - 1; i > 0; i -= 1) {
    if (pivotHighs[i] < pivotHighs[i - 1]) {
      swingLH = pivotHighs[i];
      break;
    }
  }
  return { swingHL, swingLH };
}

function dayKey(ts, tz) {
  return DateTime.fromMillis(ts, { zone: tz }).toFormat("yyyy-LL-dd");
}

function isTradingDay(dt) {
  const session = getSessionForDateTime(dt);
  return Boolean(session?.allowTradingDay);
}

function findPreviousTradingDayKey(nowDt, tz) {
  let probe = nowDt.minus({ days: 1 });
  for (let i = 0; i < 10; i += 1) {
    if (isTradingDay(probe)) return probe.toFormat("yyyy-LL-dd");
    probe = probe.minus({ days: 1 });
  }
  return null;
}

function resolveSessionOpenTs(nowDt, sessionOpenTs) {
  if (Number.isFinite(Number(sessionOpenTs))) return Number(sessionOpenTs);
  const session = getSessionForDateTime(nowDt);
  const bounds = buildBoundsForToday(session, nowDt);
  return bounds?.open?.isValid
    ? bounds.open.toMillis()
    : nowDt.startOf("day").plus({ hours: 9, minutes: 15 }).toMillis();
}

function computeStructureLevels({
  env = {},
  tz = "Asia/Kolkata",
  nowMs,
  underlyingToken,
  underlyingCandles,
  underlyingTicksOrLtpSeries,
  breakoutLevel,
  // backward compatibility
  candles,
  nowTs,
  sessionOpenTs,
  orbMinutes,
}) {
  const sourceCandles = Array.isArray(underlyingCandles) ? underlyingCandles : candles;
  const limit = Math.max(30, Number(env.STRUCTURE_CANDLE_LIMIT ?? 1200));
  const parsed = (Array.isArray(sourceCandles) ? sourceCandles.slice(-limit) : [])
    .map((c) => ({ ...c, _ts: candleTs(c) }))
    .filter((c) => Number.isFinite(c._ts))
    .sort((a, b) => a._ts - b._ts);

  if (!parsed.length) {
    return {
      dayHigh: null,
      dayLow: null,
      prevDayHigh: null,
      prevDayLow: null,
      weekHigh: null,
      weekLow: null,
      orbHigh: null,
      orbLow: null,
      vwap: null,
      swingHL: null,
      swingLH: null,
      breakoutLevel: Number.isFinite(Number(breakoutLevel)) ? Number(breakoutLevel) : null,
      meta: { ok: false, reason: "no_candles", usedBars: 0, underlyingToken: underlyingToken ?? null },
    };
  }

  const now = Number.isFinite(Number(nowMs))
    ? Number(nowMs)
    : Number.isFinite(Number(nowTs))
      ? Number(nowTs)
      : parsed[parsed.length - 1]._ts;
  const nowDt = DateTime.fromMillis(now, { zone: tz });
  const nowDayKey = nowDt.toFormat("yyyy-LL-dd");
  const sessionOpen = resolveSessionOpenTs(nowDt, sessionOpenTs);

  const dayBuckets = new Map();
  for (const c of parsed) {
    const key = dayKey(c._ts, tz);
    if (!dayBuckets.has(key)) dayBuckets.set(key, []);
    dayBuckets.get(key).push(c);
  }

  const prevTradingDayKey = findPreviousTradingDayKey(nowDt, tz);
  const prevDayRows = prevTradingDayKey ? dayBuckets.get(prevTradingDayKey) || [] : [];

  const dayRows = parsed.filter((c) => c._ts >= sessionOpen && c._ts <= now);
  const orderedDayKeys = Array.from(dayBuckets.keys()).sort();
  const tradingSessionKeys = orderedDayKeys.filter((k) => k <= nowDayKey).slice(-5);
  const weekRows = tradingSessionKeys.flatMap((k) => dayBuckets.get(k) || []);

  const day = hiLo(dayRows);
  const prev = hiLo(prevDayRows);
  const week = hiLo(weekRows);
  const orbM = Math.max(1, Number(orbMinutes ?? env.ORB_MINUTES ?? 15));
  const orbRows = dayRows.filter((c) => c._ts <= sessionOpen + orbM * 60 * 1000);
  const orb = hiLo(orbRows);
  const vwap = computeVwap(dayRows);
  const swings = computeSwingLevels(dayRows.length ? dayRows : parsed, 2);

  return {
    dayHigh: day.high,
    dayLow: day.low,
    prevDayHigh: prev.high,
    prevDayLow: prev.low,
    weekHigh: week.high,
    weekLow: week.low,
    orbHigh: orb.high,
    orbLow: orb.low,
    vwap,
    swingHL: swings.swingHL,
    swingLH: swings.swingLH,
    breakoutLevel: Number.isFinite(Number(breakoutLevel))
      ? Number(breakoutLevel)
      : Number.isFinite(Number(underlyingTicksOrLtpSeries?.breakoutLevel))
        ? Number(underlyingTicksOrLtpSeries.breakoutLevel)
        : null,
    meta: {
      ok: true,
      usedBars: parsed.length,
      dayBars: dayRows.length,
      prevDayBars: prevDayRows.length,
      weekBars: weekRows.length,
      sessionOpenTs: sessionOpen,
      orbMinutes: orbM,
      nowDayKey,
      prevTradingDayKey,
      underlyingToken: underlyingToken ?? null,
    },
  };
}

module.exports = { computeStructureLevels };
