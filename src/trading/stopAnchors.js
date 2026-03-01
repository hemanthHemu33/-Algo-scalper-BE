const { applyLiquidityBuffer } = require("./liquidityBuffer");

function parseAnchorMap(raw) {
  const out = new Map();
  const text = String(raw || "");
  for (const pair of text.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = pair.split(":").map((x) => String(x || "").trim());
    if (k && v) out.set(k.toLowerCase(), v.toUpperCase());
  }
  return out;
}

function chooseAnchorFamily(strategyId, env = {}) {
  const raw = env.STRATEGY_STOP_ANCHOR_MAP || env.STOP_ANCHOR_MAP || "";
  const parsed = parseAnchorMap(raw);
  return parsed.get(String(strategyId || "").toLowerCase()) || "SWING";
}

function getAnchorCandidate({ family, side, levels }) {
  const dir = String(side || "BUY").toUpperCase();
  const defs = {
    ORB: dir === "BUY"
      ? { anchorType: "ORB_BREAKOUT", anchorPrice: levels?.orbLow }
      : { anchorType: "ORB_BREAKOUT", anchorPrice: levels?.orbHigh },
    DAY_LEVEL: dir === "BUY"
      ? { anchorType: "DAY_HIGH_RETEST", anchorPrice: levels?.dayLow }
      : { anchorType: "DAY_LOW_RETEST", anchorPrice: levels?.dayHigh },
    VWAP: { anchorType: "VWAP_RECLAIM", anchorPrice: levels?.vwap },
    SWING: dir === "BUY"
      ? { anchorType: "SWING_LOW", anchorPrice: levels?.lastSwingLow ?? levels?.swingHL }
      : { anchorType: "SWING_HIGH", anchorPrice: levels?.lastSwingHigh ?? levels?.swingLH },
  };
  return defs[family] || defs.SWING;
}

function computeStopAnchor({ strategyId, side, levels, entryContext = {}, nowContext = {} }) {
  const env = nowContext.env || {};
  const dir = String(side || "BUY").toUpperCase();
  const tickSize = Number(nowContext.tickSize ?? entryContext.tickSize ?? 0.05);
  const ltp = Number(nowContext.ltp);
  const atrPts = Number(nowContext.atrPts);

  const family = chooseAnchorFamily(strategyId, env);
  const picked = getAnchorCandidate({ family, side: dir, levels });
  const anchorPriceRaw = Number(picked.anchorPrice);
  const anchorPrice = Number.isFinite(anchorPriceRaw) && picked.anchorPrice !== null && picked.anchorPrice !== undefined ? anchorPriceRaw : null;
  if (!Number.isFinite(anchorPrice)) {
    return {
      anchorType: `${picked.anchorType}_UNAVAILABLE`,
      anchorPrice: null,
      bufferPts: null,
      recommendedSL: null,
      family,
    };
  }

  const buffered = applyLiquidityBuffer({
    env: {
      ...env,
      LIQUIDITY_BUFFER_MODE: "ATR",
      LIQUIDITY_BUFFER_ATR_MULT: Number(env.LIQ_BUFFER_ATR_PCT ?? env.LIQUIDITY_BUFFER_ATR_MULT ?? 0.1),
      LIQUIDITY_BUFFER_MIN_TICKS: Number(env.LIQ_BUFFER_MIN_TICKS ?? env.LIQUIDITY_BUFFER_MIN_TICKS ?? 4),
      LIQUIDITY_BUFFER_MAX_TICKS: Number(env.LIQ_BUFFER_MAX_TICKS ?? env.LIQUIDITY_BUFFER_MAX_TICKS ?? 30),
      ROUND_NUMBER_GUARD_ENABLED: String(env.AVOID_ROUND_LEVELS ?? env.ROUND_NUMBER_GUARD_ENABLED ?? "true"),
      ROUND_NUMBER_STEP: Number(env.ROUND_LEVEL_STEP ?? env.ROUND_NUMBER_STEP ?? 50),
      ROUND_NUMBER_BUFFER_TICKS: Number(env.ROUND_NUMBER_BUFFER_TICKS ?? 4),
    },
    side: dir,
    candidateSL: anchorPrice,
    tickSize,
    atrPts,
    ltp,
    roundNumberStep: Number(env.ROUND_LEVEL_STEP ?? env.ROUND_NUMBER_STEP ?? 50),
  });

  return {
    anchorType: picked.anchorType,
    anchorPrice,
    bufferPts: Number.isFinite(Number(buffered?.bufferPts)) ? Number(buffered.bufferPts) : null,
    bufferTicks: Number.isFinite(Number(buffered?.bufferTicks)) ? Number(buffered.bufferTicks) : null,
    recommendedSL: Number.isFinite(Number(buffered?.bufferedSL)) ? Number(buffered.bufferedSL) : null,
    roundGuardApplied: Boolean(buffered?.roundGuardApplied),
    family,
  };
}

module.exports = { computeStopAnchor, parseAnchorMap, chooseAnchorFamily };
