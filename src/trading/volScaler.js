function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return n;
  return Math.min(Math.max(n, lo), hi);
}

function computeVolScaler({ env = {}, atrPts, atrBps }) {
  const min = Number(env.VOL_SCALER_MIN ?? 0.8);
  const max = Number(env.VOL_SCALER_MAX ?? 1.3);
  const targetPts = Number(env.VOL_ATR_TARGET_PTS ?? 18);
  const targetBps = Number(env.VOL_TARGET_BPS ?? env.RISK_VOL_TARGET_BPS ?? 65);

  const sourceAtr = Number.isFinite(Number(atrPts)) && Number(atrPts) > 0
    ? Number(atrPts)
    : Number.isFinite(Number(atrBps)) && Number(atrBps) > 0
      ? Number(atrBps)
      : null;
  const sourceTarget = Number.isFinite(Number(atrPts)) && Number(atrPts) > 0
    ? targetPts
    : targetBps;

  if (!(Number.isFinite(sourceAtr) && sourceAtr > 0 && Number.isFinite(sourceTarget) && sourceTarget > 0)) {
    return clamp(1, min, max);
  }
  const scaler = sourceAtr / sourceTarget;
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
