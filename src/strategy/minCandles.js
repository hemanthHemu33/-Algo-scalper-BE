const DEFAULT_MIN = 50;

function parseMinByInterval(value) {
  const map = new Map();
  String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const [intervalRaw, minRaw] = entry.split(/[:=]/).map((s) => s.trim());
      const interval = Number(intervalRaw);
      const min = Number(minRaw);
      if (Number.isFinite(interval) && interval > 0 && Number.isFinite(min)) {
        map.set(interval, min);
      }
    });
  return map;
}

function getMinCandlesForSignal(env, intervalMin) {
  const fallback = Number(env.MIN_CANDLES_FOR_SIGNAL || DEFAULT_MIN);
  const interval = Number(intervalMin);
  if (!Number.isFinite(interval) || interval <= 0) return fallback;

  const overrides = parseMinByInterval(env.MIN_CANDLES_BY_INTERVAL);
  if (overrides.has(interval)) return Number(overrides.get(interval));
  return fallback;
}

function getMinCandlesForRegime(env) {
  return Number(
    env.MIN_CANDLES_FOR_REGIME || env.MIN_CANDLES_FOR_SIGNAL || DEFAULT_MIN,
  );
}

module.exports = {
  getMinCandlesForSignal,
  getMinCandlesForRegime,
};
