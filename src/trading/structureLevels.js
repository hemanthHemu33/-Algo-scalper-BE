const { DateTime } = require("luxon");

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function candleTs(c) {
  if (!c) return null;
  if (c.date != null) {
    const t = new Date(c.date).getTime();
    if (Number.isFinite(t)) return t;
  }
  if (c.timestamp != null) {
    const t = Number(c.timestamp);
    if (Number.isFinite(t)) return t;
  }
  if (c.ts != null) {
    const t = Number(c.ts);
    if (Number.isFinite(t)) return t;
  }
  if (c.time != null) {
    const t = new Date(c.time).getTime();
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function dayKey(ts, tz) {
  return DateTime.fromMillis(ts, { zone: tz }).toFormat("yyyy-LL-dd");
}

function isoWeekKey(ts, tz) {
  const dt = DateTime.fromMillis(ts, { zone: tz });
  return `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, "0")}`;
}

function hiLo(rows) {
  const highs = rows.map((r) => toNum(r.high)).filter((n) => Number.isFinite(n));
  const lows = rows.map((r) => toNum(r.low)).filter((n) => Number.isFinite(n));
  if (!highs.length || !lows.length) return { high: null, low: null };
  return { high: Math.max(...highs), low: Math.min(...lows) };
}

function computeVwap(rows) {
  let pv = 0;
  let vv = 0;
  let hasVolume = false;
  for (const c of rows) {
    const hi = toNum(c.high);
    const lo = toNum(c.low);
    const cl = toNum(c.close);
    const vol = toNum(c.volume);
    if (!(Number.isFinite(hi) && Number.isFinite(lo) && Number.isFinite(cl))) continue;
    if (!(Number.isFinite(vol) && vol > 0)) continue;
    hasVolume = true;
    const tp = (hi + lo + cl) / 3;
    pv += tp * vol;
    vv += vol;
  }
  return {
    vwap: hasVolume && vv > 0 ? pv / vv : null,
    hasVolume,
  };
}

function computeStructureLevels({
  candles,
  tz = "Asia/Kolkata",
  nowTs,
  sessionOpenTs,
  orbMinutes,
  env,
}) {
  const limit = Math.max(30, Number(env?.STRUCTURE_CANDLE_LIMIT ?? 800));
  const source = Array.isArray(candles) ? candles.slice(-limit) : [];
  if (!source.length) return { ok: false, reason: "no_candles", meta: { usedBars: 0 } };

  const parsed = source
    .map((c) => ({ ...c, _ts: candleTs(c) }))
    .filter((c) => Number.isFinite(c._ts))
    .sort((a, b) => a._ts - b._ts);
  if (!parsed.length) return { ok: false, reason: "no_timestamped_candles", meta: { usedBars: 0 } };

  const now = Number.isFinite(Number(nowTs)) ? Number(nowTs) : parsed[parsed.length - 1]._ts;
  const dayStart = Number.isFinite(Number(sessionOpenTs))
    ? Number(sessionOpenTs)
    : DateTime.fromMillis(now, { zone: tz }).startOf("day").plus({ hours: 9, minutes: 15 }).toMillis();

  const dayRows = parsed.filter((c) => c._ts >= dayStart && c._ts <= now);
  if (!dayRows.length) {
    return {
      ok: false,
      reason: "no_intraday_rows",
      meta: { usedBars: parsed.length, dayRangeBars: 0, sessionOpenTs: dayStart, orbEndTs: null },
    };
  }

  const orbMin = Math.max(1, Number(orbMinutes ?? env?.ORB_MINUTES ?? 15));
  const orbEndTs = dayStart + orbMin * 60 * 1000;
  const orbRows = parsed.filter((c) => c._ts >= dayStart && c._ts <= orbEndTs);
  const day = hiLo(dayRows);
  const orb = hiLo(orbRows);
  const { vwap, hasVolume } = computeVwap(dayRows);

  const dayBuckets = new Map();
  for (const c of parsed) {
    const dk = dayKey(c._ts, tz);
    if (!dayBuckets.has(dk)) dayBuckets.set(dk, []);
    dayBuckets.get(dk).push(c);
  }
  const keys = Array.from(dayBuckets.keys()).sort();
  const nowKey = dayKey(now, tz);
  const prevDayKey = keys.filter((k) => k < nowKey).pop() || null;
  const prevDayRows = prevDayKey ? dayBuckets.get(prevDayKey) || [] : [];
  const prevDay = hiLo(prevDayRows);

  const nowWeekKey = isoWeekKey(now, tz);
  const weekRows = parsed.filter((c) => isoWeekKey(c._ts, tz) === nowWeekKey && c._ts <= now);
  const week = hiLo(weekRows);

  return {
    ok: true,
    dayHigh: day.high,
    dayLow: day.low,
    prevDayHigh: prevDay.high,
    prevDayLow: prevDay.low,
    weekHigh: week.high,
    weekLow: week.low,
    orbHigh: orb.high,
    orbLow: orb.low,
    vwap,
    meta: {
      usedBars: parsed.length,
      hasVolume,
      sessionOpenTs: dayStart,
      orbEndTs,
      dayRangeBars: dayRows.length,
      prevDayBars: prevDayRows.length,
      weekBars: weekRows.length,
    },
  };
}

module.exports = { computeStructureLevels };
