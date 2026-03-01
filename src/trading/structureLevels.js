const { DateTime } = require("luxon");

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
  if (!Array.isArray(rows) || !rows.length) return { high: null, low: null };
  const highs = rows.map((r) => toNum(r.high)).filter(Number.isFinite);
  const lows = rows.map((r) => toNum(r.low)).filter(Number.isFinite);
  if (!highs.length || !lows.length) return { high: null, low: null };
  return { high: Math.max(...highs), low: Math.min(...lows) };
}

function computeVwap(rows) {
  let pv = 0;
  let volSum = 0;
  for (const c of rows || []) {
    const h = toNum(c.high);
    const l = toNum(c.low);
    const cl = toNum(c.close);
    const v = toNum(c.volume);
    if (!(Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(cl) && Number.isFinite(v) && v > 0)) continue;
    const typical = (h + l + cl) / 3;
    pv += typical * v;
    volSum += v;
  }
  return volSum > 0 ? pv / volSum : null;
}

function computeLastSwings(rows, lookback) {
  const out = { lastSwingHigh: null, lastSwingLow: null };
  const n = Math.max(2, Number(lookback) || 20);
  if (!Array.isArray(rows) || rows.length < n + 2) return out;
  const slice = rows.slice(-Math.max(n + 2, 10));
  for (let i = slice.length - 2; i >= 1; i -= 1) {
    const prev = slice[i - 1];
    const cur = slice[i];
    const next = slice[i + 1];
    const ch = toNum(cur.high);
    const ph = toNum(prev.high);
    const nh = toNum(next.high);
    if (out.lastSwingHigh == null && [ch, ph, nh].every(Number.isFinite) && ch > ph && ch > nh) {
      out.lastSwingHigh = ch;
    }
    const cl = toNum(cur.low);
    const pl = toNum(prev.low);
    const nl = toNum(next.low);
    if (out.lastSwingLow == null && [cl, pl, nl].every(Number.isFinite) && cl < pl && cl < nl) {
      out.lastSwingLow = cl;
    }
    if (out.lastSwingHigh != null && out.lastSwingLow != null) break;
  }
  return out;
}

function computeStructureLevels({
  env = {},
  tz = "Asia/Kolkata",
  nowMs,
  underlyingCandles,
  premiumCandles,
  candles,
  sessionOpenTs,
  orbMinutes,
  breakoutLevel,
  underlyingToken,
}) {
  const source = Array.isArray(underlyingCandles) && underlyingCandles.length
    ? underlyingCandles
    : Array.isArray(candles) && candles.length
      ? candles
      : premiumCandles;

  const parsed = (Array.isArray(source) ? source : [])
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
      lastSwingHigh: null,
      lastSwingLow: null,
      swingHL: null,
      swingLH: null,
      breakoutLevel: Number.isFinite(Number(breakoutLevel)) ? Number(breakoutLevel) : null,
      meta: { ok: false, reason: "no_candles", underlyingToken: underlyingToken ?? null },
    };
  }

  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : parsed[parsed.length - 1]._ts;
  const nowDt = DateTime.fromMillis(now, { zone: tz });
  const sessionOpen = Number.isFinite(Number(sessionOpenTs))
    ? Number(sessionOpenTs)
    : nowDt.startOf("day").plus({ hours: 9, minutes: 15 }).toMillis();
  const orbM = Math.max(1, Number(orbMinutes ?? env.ORB_MINUTES ?? 15));

  const dayBuckets = new Map();
  for (const c of parsed) {
    const key = DateTime.fromMillis(c._ts, { zone: tz }).toFormat("yyyy-LL-dd");
    if (!dayBuckets.has(key)) dayBuckets.set(key, []);
    dayBuckets.get(key).push(c);
  }
  const dayKeys = Array.from(dayBuckets.keys()).sort();
  const nowDayKey = nowDt.toFormat("yyyy-LL-dd");
  const prevDayKey = dayKeys.filter((k) => k < nowDayKey).pop() || null;

  const todayRows = parsed.filter((c) => c._ts >= sessionOpen && c._ts <= now);
  const prevDayRows = prevDayKey ? dayBuckets.get(prevDayKey) || [] : [];
  const weekRows = dayKeys.slice(-5).flatMap((k) => dayBuckets.get(k) || []);
  const orbRows = todayRows.filter((c) => c._ts <= sessionOpen + orbM * 60 * 1000);

  const day = hiLo(todayRows);
  const prev = hiLo(prevDayRows);
  const week = hiLo(weekRows);
  const swings = computeLastSwings(todayRows.length ? todayRows : parsed, Number(env.SWING_LOOKBACK ?? 20));

  return {
    dayHigh: day.high,
    dayLow: day.low,
    prevDayHigh: prev.high,
    prevDayLow: prev.low,
    weekHigh: week.high,
    weekLow: week.low,
    orbHigh: hiLo(orbRows).high,
    orbLow: hiLo(orbRows).low,
    vwap: String(env.VWAP_ENABLED ?? "true") === "true" ? computeVwap(todayRows) : null,
    lastSwingHigh: swings.lastSwingHigh,
    lastSwingLow: swings.lastSwingLow,
    // Backwards compatibility for existing anchor resolution
    swingHL: swings.lastSwingLow,
    swingLH: swings.lastSwingHigh,
    breakoutLevel: Number.isFinite(Number(breakoutLevel)) ? Number(breakoutLevel) : null,
    meta: {
      ok: true,
      dayKey: nowDayKey,
      prevDayKey,
      usedBars: parsed.length,
      underlyingToken: underlyingToken ?? null,
    },
  };
}

module.exports = { computeStructureLevels };
