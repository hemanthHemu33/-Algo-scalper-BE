const { roundToTick } = require("./priceUtils");

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

function applyLiquidityBuffer({ env = {}, side, candidateSL, tickSize, atrPts, roundNumberStep, ltp }) {
  const sl = Number(candidateSL);
  const tick = Math.max(Number(tickSize) || 0.05, 0.0001);
  const dir = String(side || "BUY").toUpperCase();
  if (!Number.isFinite(sl)) {
    return { bufferedSL: null, bufferTicks: 0, bufferPts: 0, roundGuardApplied: false };
  }

  const mode = String(env.LIQUIDITY_BUFFER_MODE || "ATR").toUpperCase();
  const minTicks = Math.max(0, Number(env.LIQUIDITY_BUFFER_MIN_TICKS ?? 4));
  const maxTicks = Math.max(minTicks, Number(env.LIQUIDITY_BUFFER_MAX_TICKS ?? 20));
  const atrMult = Math.max(0, Number(env.LIQUIDITY_BUFFER_ATR_MULT ?? 0.1));

  const baseTicksRaw = mode === "ATR" && Number.isFinite(atrPts) && Number(atrPts) > 0
    ? Math.ceil((Number(atrPts) * atrMult) / tick)
    : minTicks;
  const bufferTicks = clamp(baseTicksRaw, minTicks, maxTicks);
  const bufferPts = bufferTicks * tick;

  let bufferedSL = dir === "SELL" ? sl + bufferPts : sl - bufferPts;
  let roundGuardApplied = false;

  const roundGuardEnabled = String(env.ROUND_NUMBER_GUARD_ENABLED ?? "true") === "true";
  const step = Number(roundNumberStep ?? env.ROUND_NUMBER_STEP ?? 50);
  const roundTicks = Math.max(0, Number(env.ROUND_NUMBER_BUFFER_TICKS ?? 4));
  if (roundGuardEnabled && Number.isFinite(step) && step > 0 && roundTicks > 0) {
    const nearestRound = Math.round(sl / step) * step;
    const nearRound = Math.abs(sl - nearestRound) <= roundTicks * tick;
    if (nearRound) {
      const shift = roundTicks * tick;
      bufferedSL = dir === "SELL" ? bufferedSL + shift : bufferedSL - shift;
      roundGuardApplied = true;
    }
  }

  const rounded = roundToTick(bufferedSL, tick, dir === "SELL" ? "up" : "down");
  const ltpN = Number(ltp);
  const safeSL = Number.isFinite(ltpN)
    ? dir === "SELL"
      ? Math.max(rounded, ltpN + tick)
      : Math.min(rounded, ltpN - tick)
    : rounded;

  return {
    bufferedSL: safeSL,
    bufferTicks,
    bufferPts,
    roundGuardApplied,
  };
}

module.exports = { applyLiquidityBuffer };
