const { roundToTick } = require("./priceUtils");

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function computePremiumVolPct(candles, lookback) {
  const n = Math.max(5, Number(lookback || 20));
  if (!Array.isArray(candles) || candles.length < n + 2) return null;

  const slice = candles.slice(-n);
  let sum = 0;
  let cnt = 0;
  for (let i = 1; i < slice.length; i++) {
    const prev = Number(slice[i - 1]?.close);
    const cur = Number(slice[i]?.close);
    if (
      !Number.isFinite(prev) ||
      !Number.isFinite(cur) ||
      prev <= 0 ||
      cur <= 0
    )
      continue;
    const r = Math.abs((cur - prev) / prev);
    if (!Number.isFinite(r)) continue;
    sum += r;
    cnt += 1;
  }
  if (!cnt) return null;
  return (sum / cnt) * 100; // %
}

function atrLast(candles, period) {
  const p = Math.max(5, Number(period || 14));
  if (!Array.isArray(candles) || candles.length < p + 2) return null;

  const slice = candles.slice(-(p + 1));
  let sum = 0;
  let cnt = 0;
  for (let i = 1; i < slice.length; i++) {
    const prevClose = Number(slice[i - 1]?.close);
    const h = Number(slice[i]?.high);
    const l = Number(slice[i]?.low);
    if (
      !Number.isFinite(prevClose) ||
      !Number.isFinite(h) ||
      !Number.isFinite(l)
    )
      continue;

    const tr = Math.max(
      h - l,
      Math.abs(h - prevClose),
      Math.abs(l - prevClose),
    );
    if (!Number.isFinite(tr) || tr <= 0) continue;
    sum += tr;
    cnt += 1;
  }
  if (!cnt) return null;
  return sum / cnt;
}

function buildPremiumAwareOptionPlan({
  env,
  side,
  entryPremium,
  premiumTick,
  premiumCandles,
  optionMeta,
  rrMin,
}) {
  const s = String(side || "BUY").toUpperCase();
  const e = Number(entryPremium);
  const tick = Number(premiumTick || 0.05);
  const rrMinN = Number(rrMin || 1.1);

  if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(tick) || tick <= 0) {
    return { ok: false, reason: "BAD_ENTRY_OR_TICK" };
  }

  const lookback = Number(
    env?.OPT_PLAN_VOL_LOOKBACK || env?.OPT_EXIT_VOL_LOOKBACK || 20,
  );
  const volRef = Number(
    env?.OPT_PLAN_VOL_REF_PCT || env?.OPT_EXIT_VOL_REF_PCT || 6,
  );
  const baseSlPct = Number(
    env?.OPT_PLAN_BASE_SL_PCT || env?.OPT_EXIT_BASE_SL_PCT || 18,
  );
  const baseTpPct = Number(
    env?.OPT_PLAN_BASE_TARGET_PCT || env?.OPT_EXIT_BASE_TARGET_PCT || 35,
  );
  const minSlPct = Number(
    env?.OPT_PLAN_MIN_SL_PCT || env?.OPT_EXIT_MIN_SL_PCT || 8,
  );
  const maxSlPct = Number(
    env?.OPT_PLAN_MAX_SL_PCT || env?.OPT_EXIT_MAX_SL_PCT || 35,
  );

  const widenMin = Number(env?.OPT_EXIT_WIDEN_FACTOR_MIN || 0.75);
  const widenMax = Number(env?.OPT_EXIT_WIDEN_FACTOR_MAX || 1.8);

  const atrPeriod = Number(env?.OPT_PLAN_PREM_ATR_PERIOD || 14);
  const atrK = Number(env?.OPT_PLAN_PREM_ATR_K || 1.2);
  const atrM = Number(env?.OPT_PLAN_PREM_ATR_M || 2.0);

  const premVolPct = computePremiumVolPct(premiumCandles, lookback);
  const atrPrem = atrLast(premiumCandles, atrPeriod);

  // If candles are missing/too short, we can still fall back to pct-only.
  const volFactor =
    Number.isFinite(premVolPct) &&
    premVolPct > 0 &&
    Number.isFinite(volRef) &&
    volRef > 0
      ? clamp(premVolPct / volRef, widenMin, widenMax)
      : 1.0;

  const dteDays = Number(optionMeta?.meta?.dteDays);
  const near =
    Number.isFinite(dteDays) && dteDays >= 0
      ? clamp((3 - dteDays) / 3, 0, 1)
      : 0;

  // Near expiry gamma makes premium whippy: widen SL slightly.
  const slPct = clamp(
    baseSlPct * volFactor * (1 + near * 0.2),
    minSlPct,
    maxSlPct,
  );

  // Targets near expiry are less reliable (IV/greek drift); keep them a bit more conservative.
  const tpPct = clamp(baseTpPct * volFactor * (1 - near * 0.05), 10, 90);

  // Spread padding: prevent SL/TP sitting inside microstructure noise.
  const bps = Math.abs(Number(optionMeta?.bps || 0));
  const spreadAbs = Number.isFinite(bps) && bps > 0 ? (e * bps) / 10000 : 0;
  const spreadPadAbs = Math.max(2 * tick, spreadAbs * 1.25);

  const atrSlAbs = Number.isFinite(atrPrem) && atrPrem > 0 ? atrPrem * atrK : 0;
  const atrTpAbs = Number.isFinite(atrPrem) && atrPrem > 0 ? atrPrem * atrM : 0;

  const slAbs = Math.max((e * slPct) / 100, atrSlAbs, spreadPadAbs);
  const tpAbsBase = Math.max((e * tpPct) / 100, atrTpAbs, spreadPadAbs);

  // Enforce minimum RR relative to the chosen SL.
  const tpAbs = Math.max(tpAbsBase, rrMinN * slAbs);

  const rawSL = s === "SELL" ? e + slAbs : e - slAbs;
  const rawTP = s === "SELL" ? e - tpAbs : e + tpAbs;

  const stopLoss = roundToTick(rawSL, tick, s === "SELL" ? "up" : "down");
  const targetPrice = roundToTick(rawTP, tick, s === "SELL" ? "down" : "up");

  // Sanity: enforce correct side.
  if (s !== "SELL" && stopLoss >= e) {
    return { ok: false, reason: "SL_NOT_BELOW_ENTRY" };
  }
  if (s === "SELL" && stopLoss <= e) {
    return { ok: false, reason: "SL_NOT_ABOVE_ENTRY" };
  }

  const R = Math.abs(e - stopLoss);
  const rr = R > 0 ? Math.abs(targetPrice - e) / R : null;

  return {
    ok: true,
    stopLoss,
    targetPrice,
    rr,
    expectedMovePerUnit: Math.abs(targetPrice - e),
    meta: {
      model: "PREMIUM_AWARE",
      premVolPct: Number.isFinite(premVolPct) ? premVolPct : null,
      atrPrem: Number.isFinite(atrPrem) ? atrPrem : null,
      atrPeriod,
      atrK,
      atrM,
      slPct,
      tpPct,
      volFactor,
      dteDays: Number.isFinite(dteDays) ? dteDays : null,
      nearExpiryFactor: near,
      spreadPadAbs,
      spreadBps: Number.isFinite(bps) ? bps : null,
    },
  };
}

module.exports = {
  buildPremiumAwareOptionPlan,
};
