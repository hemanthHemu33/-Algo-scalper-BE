const { roundToTick: roundPriceToTick } = require("../priceUtils");

function computeSpreadBps(bid, ask) {
  const b = Number(bid);
  const a = Number(ask);
  if (!(Number.isFinite(b) && b > 0 && Number.isFinite(a) && a > 0 && a >= b)) {
    return null;
  }
  const mid = (a + b) / 2;
  if (!(mid > 0)) return null;
  return ((a - b) / mid) * 10000;
}

function roundToTick(price, tickSize, dir = "nearest") {
  return roundPriceToTick(Number(price), Number(tickSize) || 0.05, dir);
}

function getTickSize(instrument) {
  const t = Number(instrument?.tick_size);
  if (Number.isFinite(t) && t > 0) return t;
  const ex = String(instrument?.exchange || "").toUpperCase();
  const type = String(instrument?.instrument_type || "").toUpperCase();
  if (ex === "NFO" && (type === "CE" || type === "PE")) return 0.05;
  return 0.05;
}

function decidePolicy({ spread_bps, passiveMax, aggressiveMax, hasDepth }) {
  if (!hasDepth) return { policy: "ABORT", reason: "no_depth" };
  const spread = Number(spread_bps);
  if (!(spread_bps !== null && spread_bps !== undefined && Number.isFinite(spread) && spread >= 0)) {
    return { policy: "ABORT", reason: "spread_unavailable" };
  }
  if (spread <= Number(passiveMax)) return { policy: "PASSIVE", reason: "tight_spread" };
  if (spread <= Number(aggressiveMax)) {
    return { policy: "AGGRESSIVE", reason: "spread_in_aggressive_band" };
  }
  return { policy: "ABORT", reason: "spread_too_wide" };
}

function computePassiveLimitPrice({ side, bid, ask, tickSize }) {
  const s = String(side || "BUY").toUpperCase();
  if (s === "BUY") return roundToTick(bid, tickSize, "down");
  return roundToTick(ask, tickSize, "up");
}

function computeAggressiveIocPrice({ side, bid, ask, tickSize, bufferTicks }) {
  const s = String(side || "BUY").toUpperCase();
  const buf = Math.max(0, Number(bufferTicks || 0)) * Number(tickSize || 0.05);
  if (s === "BUY") return roundToTick(Number(ask) + buf, tickSize, "up");
  return roundToTick(Number(bid) - buf, tickSize, "down");
}

function computeChaseBps({ basePrice, chosenPrice, side }) {
  const base = Number(basePrice);
  const chosen = Number(chosenPrice);
  if (!(Number.isFinite(base) && base > 0 && Number.isFinite(chosen) && chosen > 0)) return 0;
  const s = String(side || "BUY").toUpperCase();
  const move = s === "BUY" ? chosen - base : base - chosen;
  if (move <= 0) return 0;
  return (move / base) * 10000;
}


function validateEntrySpreadDepthPremium({
  spreadBps,
  hasDepth,
  willUseIoc = false,
  premium,
  minPremium = 0,
  maxSpreadBps,
}) {
  if (!Number.isFinite(Number(spreadBps))) return { ok: false, reason: "spread_unavailable" };
  if (Number.isFinite(Number(maxSpreadBps)) && Number(spreadBps) > Number(maxSpreadBps)) {
    return { ok: false, reason: "spread_too_wide" };
  }
  if (willUseIoc && !hasDepth) return { ok: false, reason: "no_depth_for_ioc" };
  if (Number.isFinite(Number(minPremium)) && Number(minPremium) > 0 && Number.isFinite(Number(premium)) && Number(premium) < Number(minPremium)) {
    return { ok: false, reason: "premium_too_low" };
  }
  return { ok: true };
}

function shouldUseMarketFallback({ enabled, spreadBps, maxSpreadBps }) {
  if (!enabled) return false;
  const spread = Number(spreadBps);
  const max = Number(maxSpreadBps);
  return Number.isFinite(spread) && Number.isFinite(max) && spread <= max;
}

function nextBufferTicks(baseTicks, attempt) {
  return Math.max(1, Number(baseTicks || 1)) + Math.max(0, Number(attempt || 1) - 1);
}

module.exports = {
  computeSpreadBps,
  roundToTick,
  getTickSize,
  decidePolicy,
  computePassiveLimitPrice,
  computeAggressiveIocPrice,
  computeChaseBps,
  validateEntrySpreadDepthPremium,
  shouldUseMarketFallback,
  nextBufferTicks,
};
