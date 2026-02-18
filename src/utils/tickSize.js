function normalizeTickSize(value) {
  const tick = Number(value);
  return Number.isFinite(tick) && tick > 0 ? tick : null;
}

module.exports = { normalizeTickSize };
