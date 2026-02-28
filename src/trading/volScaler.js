function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return n;
  return Math.min(Math.max(n, lo), hi);
}

function computeVolScaler({ env = {}, atrBps }) {
  const min = Number(env.VOL_SCALER_MIN ?? 0.8);
  const max = Number(env.VOL_SCALER_MAX ?? 1.3);
  const target = Number(env.VOL_TARGET_BPS ?? 65);
  const eps = 1e-6;
  if (!(Number.isFinite(atrBps) && atrBps > 0) || !(Number.isFinite(target) && target > 0)) {
    return clamp(1, min, max);
  }
  const scaler = target / Math.max(Number(atrBps), eps);
  return clamp(scaler, min, max);
}

function applyScalerToRThreshold(baseR, scaler, enabledFlag) {
  const b = Number(baseR);
  if (!Number.isFinite(b)) return baseR;
  if (!enabledFlag) return b;
  const s = Number(scaler);
  if (!Number.isFinite(s) || s <= 0) return b;
  return b * s;
}

module.exports = { computeVolScaler, applyScalerToRThreshold };
