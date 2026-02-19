const { roundToTick } = require("./priceUtils");

/**
 * Fit an option stop-loss so that (1 lot) risk fits within a given INR cap.
 *
 * This is designed for long options (CE/PE) where qty is forced to lot size.
 * If the current SL distance makes 1-lot risk exceed the cap, we tighten the SL
 * toward entry (but never tighter than minTicks).
 */
function fitStopLossToLotRiskCap({
  side,
  entry,
  stopLoss,
  lot,
  tickSize,
  capInr,
  minTicks,
}) {
  const e = Number(entry);
  const sl = Number(stopLoss);
  const lotSize = Number(lot);
  const tick = Number(tickSize ?? 0);
  const cap = Number(capInr);
  const minTicksN = Number(minTicks);

  const metaBase = {
    side,
    entry: e,
    stopLoss: sl,
    lot: lotSize,
    tick,
    capInr: cap,
    minTicks: minTicksN,
  };

  if (!Number.isFinite(e) || !Number.isFinite(sl) || !Number.isFinite(lotSize)) {
    return { ok: false, reason: "BAD_INPUT", meta: metaBase };
  }
  if (!Number.isFinite(cap) || cap <= 0) {
    return { ok: false, reason: "BAD_CAP", meta: metaBase };
  }
  if (!Number.isFinite(tick) || tick <= 0) {
    return { ok: false, reason: "BAD_TICK", meta: metaBase };
  }
  if (!Number.isFinite(lotSize) || lotSize <= 0) {
    return { ok: false, reason: "BAD_LOT", meta: metaBase };
  }

  const allowedPerUnitRisk = cap / lotSize;
  const currentPerUnitRisk = Math.abs(e - sl);

  const minStop = Math.max(tick, (Number.isFinite(minTicksN) ? minTicksN : 0) * tick);

  // Already fits.
  if (currentPerUnitRisk <= allowedPerUnitRisk + 1e-9) {
    return {
      ok: true,
      changed: false,
      stopLoss: sl,
      perUnitRisk: currentPerUnitRisk,
      allowedPerUnitRisk,
      minStop,
    };
  }

  // Cannot fit without violating minStop distance.
  if (allowedPerUnitRisk + 1e-9 < minStop) {
    return {
      ok: false,
      reason: "CAP_TOO_LOW_FOR_MIN_STOP",
      meta: {
        ...metaBase,
        allowedPerUnitRisk,
        currentPerUnitRisk,
        minStop,
      },
    };
  }

  // Tighten to exactly the allowed per-unit risk (bounded by minStop).
  const desiredPerUnitRisk = Math.max(minStop, Math.min(currentPerUnitRisk, allowedPerUnitRisk));

  let rawSl;
  if (side === "SELL") rawSl = e + desiredPerUnitRisk;
  else rawSl = e - desiredPerUnitRisk; // BUY default

  // Round toward entry to avoid increasing risk due to tick rounding.
  const roundMode = side === "SELL" ? "down" : "up";
  let fitted = roundToTick(rawSl, tick, roundMode);

  // Ensure SL stays on the correct side.
  if (side === "SELL" && fitted <= e) fitted = roundToTick(e + tick, tick, "up");
  if (side !== "SELL" && fitted >= e) fitted = roundToTick(e - tick, tick, "down");

  // Validate post-rounding risk.
  let finalPerUnitRisk = Math.abs(e - fitted);

  // In very rare cases, rounding could still exceed the cap by ~1 tick. Nudge one tick closer.
  if (finalPerUnitRisk > allowedPerUnitRisk + 1e-9) {
    fitted =
      side === "SELL"
        ? roundToTick(fitted - tick, tick, "down")
        : roundToTick(fitted + tick, tick, "up");
    finalPerUnitRisk = Math.abs(e - fitted);
  }

  if (finalPerUnitRisk > allowedPerUnitRisk + 1e-9) {
    return {
      ok: false,
      reason: "ROUNDING_CANNOT_FIT",
      meta: {
        ...metaBase,
        allowedPerUnitRisk,
        currentPerUnitRisk,
        minStop,
        fitted,
        finalPerUnitRisk,
      },
    };
  }

  return {
    ok: true,
    changed: true,
    stopLoss: fitted,
    perUnitRisk: finalPerUnitRisk,
    allowedPerUnitRisk,
    minStop,
  };
}

function computeTargetFromRR({ side, entry, stopLoss, rr, tickSize }) {
  const e = Number(entry);
  const sl = Number(stopLoss);
  const rrN = Number(rr);
  const tick = Number(tickSize ?? 0);

  if (!Number.isFinite(e) || !Number.isFinite(sl) || !Number.isFinite(rrN) || rrN <= 0) {
    return null;
  }
  if (!Number.isFinite(tick) || tick <= 0) return null;

  const R = Math.abs(e - sl);
  if (!Number.isFinite(R) || R <= 0) return null;

  const rawTarget = side === "SELL" ? e - rrN * R : e + rrN * R;
  const mode = side === "SELL" ? "down" : "up";
  return roundToTick(rawTarget, tick, mode);
}

module.exports = {
  fitStopLossToLotRiskCap,
  computeTargetFromRR,
};
