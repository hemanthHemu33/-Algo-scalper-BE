function tickDecimals(tickSize) {
  const t = Number(tickSize);
  if (!Number.isFinite(t) || t <= 0) return 2;
  // Works for common tick sizes (0.05, 0.1, 0.01, 0.005, etc.)
  const s = String(t);
  if (s.includes('e-')) {
    // e.g. 1e-7
    return Number(s.split('e-')[1] || 0);
  }
  const dot = s.indexOf('.');
  return dot >= 0 ? (s.length - dot - 1) : 0;
}

function roundToTick(price, tickSize, mode = "nearest") {
  const p = Number(price);
  const t = Number(tickSize || 0.05);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return p;

  const q = p / t;
  let out;
  if (mode === "down") out = Math.floor(q) * t;
  else if (mode === "up") out = Math.ceil(q) * t;
  else out = Math.round(q) * t;

  // Avoid floating artifacts (e.g. 99.80000000001) which can cause broker rejections.
  const dec = tickDecimals(t);
  return Number(out.toFixed(dec));
}

module.exports = { roundToTick, tickDecimals };
