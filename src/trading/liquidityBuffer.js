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

  const minTicks = Math.max(0, Number(env.LIQ_BUFFER_MIN_TICKS ?? env.LIQUIDITY_BUFFER_MIN_TICKS ?? 4));
  const maxTicks = Math.max(minTicks, Number(env.LIQ_BUFFER_MAX_TICKS ?? env.LIQUIDITY_BUFFER_MAX_TICKS ?? 30));
  const atrMult = Math.max(0, Number(env.LIQ_BUFFER_ATR_PCT ?? env.LIQUIDITY_BUFFER_ATR_MULT ?? 0.1));

  const baseTicksRaw = Number.isFinite(atrPts) && Number(atrPts) > 0
    ? Math.ceil((Number(atrPts) * atrMult) / tick)
    : minTicks;
  const bufferTicks = clamp(baseTicksRaw, minTicks, maxTicks);
  const bufferPts = bufferTicks * tick;

  let bufferedSL = dir === "SELL" ? sl + bufferPts : sl - bufferPts;
  let roundGuardApplied = false;

  const roundGuardEnabled = String(env.AVOID_ROUND_LEVELS ?? env.ROUND_NUMBER_GUARD_ENABLED ?? "true") === "true";
  const step = Number(roundNumberStep ?? env.ROUND_LEVEL_STEP ?? env.ROUND_NUMBER_STEP ?? 50);
  const shiftTicks = Math.max(1, Number(env.ROUND_NUMBER_BUFFER_TICKS ?? minTicks));
  if (roundGuardEnabled && Number.isFinite(step) && step > 0) {
    const remainder = ((bufferedSL % step) + step) % step;
    const nearZero = Math.abs(remainder) <= tick / 2;
    const nearHalf = Math.abs(remainder - step / 2) <= tick / 2;
    if (nearZero || nearHalf) {
      const shift = shiftTicks * tick;
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
