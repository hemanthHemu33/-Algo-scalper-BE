function toMs(v) {
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const d = new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? t : Date.now();
}

function createBacktestClock(startTs) {
  let nowMs = toMs(startTs || Date.now());
  return {
    nowMs: () => nowMs,
    nowDate: () => new Date(nowMs),
    set: (ts) => {
      nowMs = toMs(ts);
      return nowMs;
    },
    advanceMs: (delta) => {
      const d = Number(delta);
      if (Number.isFinite(d)) nowMs += d;
      return nowMs;
    },
  };
}

module.exports = { createBacktestClock };
