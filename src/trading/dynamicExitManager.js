// dynamicExitManager.js
// Computes dynamic SL/Target updates for an open trade.
//
// Pro upgrades:
// - "True breakeven": move SL to entry +/- estimated per-share costs (so BE exits aren't fee-negative)
// - Start trailing only after the trade has earned enough (reduces noise stopouts)
// - Options-aware fallbacks: premium % model + time-stop + coarse IV spike/crush heuristics
//
// Design goals:
// - Cash equities: never loosen risk (SL only trails in the direction of profit).
// - Options: allow *controlled* early widening if the initial SL is unrealistically tight for premium noise.
// - Update infrequently (throttle in TradeManager) to avoid rate-limits.
// - Keep broker validity constraints in mind (tick size, SL trigger relationships).

const { roundToTick } = require("./priceUtils");
const { atr, rollingVWAP, maxHigh, minLow } = require("../strategy/utils");
const { estimateRoundTripCostInr } = require("./costModel");
const { getEffectivePrice } = require("../market/effectivePrice");

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return n;
  if (Number.isFinite(lo)) n = Math.max(lo, n);
  if (Number.isFinite(hi)) n = Math.min(hi, n);
  return n;
}

function safeNum(v, fb = null) {
  if (v === null || v === undefined || v === "") return fb;
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function toFiniteOrNaN(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function tsFrom(v) {
  if (!v) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const d = new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

function isOptionTrade(trade) {
  if (!trade) return false;
  if (trade.option_meta || trade.optionMeta || trade.option) return true;

  const seg = String(trade.instrument?.segment || "").toUpperCase();
  if (seg.includes("OPT")) return true;

  const sym = String(trade.instrument?.tradingsymbol || "").toUpperCase();
  if (/\d(?:CE|PE)$/.test(sym)) return true;

  return false;
}

function optionType(trade) {
  const t =
    trade?.option_meta?.optType ||
    trade?.optionMeta?.optType ||
    trade?.option?.optType ||
    null;
  const s = String(t || "").toUpperCase();
  if (s === "CE" || s === "CALL") return "CE";
  if (s === "PE" || s === "PUT") return "PE";

  const sym = String(trade?.instrument?.tradingsymbol || "").toUpperCase();
  if (/\dCE$/.test(sym)) return "CE";
  if (/\dPE$/.test(sym)) return "PE";

  return null;
}

function computeBaseRisk(trade) {
  const entry = Number(trade.entryPrice ?? trade.candle?.close);
  const sl0 = Number(trade.initialStopLoss ?? trade.stopLoss);
  const risk = Math.abs(entry - sl0);
  return { entry, sl0, risk: Number.isFinite(risk) ? risk : 0 };
}

function profitR({ side, entry, ltp, risk }) {
  if (!Number.isFinite(entry) || !Number.isFinite(ltp) || !(risk > 0)) return 0;
  return side === "BUY" ? (ltp - entry) / risk : (entry - ltp) / risk;
}

function bestPeakLtp({ trade, ltp, side }) {
  const dbPeak = toFiniteOrNaN(trade?.peakLtp);
  if (Number.isFinite(dbPeak)) {
    if (side === "BUY") return Number.isFinite(ltp) ? Math.max(dbPeak, ltp) : dbPeak;
    if (side === "SELL") return Number.isFinite(ltp) ? Math.min(dbPeak, ltp) : dbPeak;
  }
  return Number.isFinite(ltp) ? ltp : null;
}

function profitPct({ side, entry, ltp }) {
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(ltp) ||
    ltp <= 0
  )
    return 0;
  const raw = side === "BUY" ? (ltp - entry) / entry : (entry - ltp) / entry;
  return raw * 100;
}

function unrealizedPnlInr({ side, entry, ltp, qty }) {
  if (!Number.isFinite(entry) || !Number.isFinite(ltp) || !Number.isFinite(qty))
    return 0;
  if (side === "BUY") return (ltp - entry) * qty;
  return (entry - ltp) * qty;
}

function meetsThreshold(value, threshold, epsilon = 0) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold <= 0) {
    return false;
  }
  const eps = Number.isFinite(epsilon) && epsilon > 0 ? epsilon : 0;
  return value + eps >= threshold;
}

function computeTargetFromRisk({ side, entry, risk, rr, tick }) {
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(risk) ||
    risk <= 0
  )
    return null;
  const raw = side === "BUY" ? entry + rr * risk : entry - rr * risk;
  return roundToTick(raw, tick, side === "BUY" ? "up" : "down");
}

function estimateTrueBreakeven({ trade, entry, side, tick, env }) {
  const qty = Number(trade.qty ?? trade.initialQty ?? 0);
  const mult = Number(env.DYN_BE_COST_MULT ?? 1.0);
  const spreadBps = Number(trade?.quoteAtEntry?.bps ?? 0);

  // Fallback: breakeven defaults to entry when qty/entry is unavailable.
  if (!Number.isFinite(entry) || entry <= 0 || !(qty > 0)) {
    return {
      be: roundToTick(entry, tick, side === "BUY" ? "up" : "down"),
      meta: { qty, mult, note: "no_qty_or_entry" },
    };
  }

  const { estCostInr, meta } = estimateRoundTripCostInr({
    entryPrice: entry,
    qty,
    spreadBps,
    includeSpread: true,
    env,
    instrument: trade?.instrument || null,
  });

  const costPerShare =
    Number.isFinite(estCostInr) && estCostInr > 0 ? estCostInr / qty : 0;

  const raw =
    side === "BUY"
      ? entry + mult * costPerShare
      : entry - mult * costPerShare;

  const be = roundToTick(raw, tick, side === "BUY" ? "up" : "down");
  return {
    be,
    meta: {
      qty,
      estCostInr,
      costPerShare,
      spreadBps,
      mult,
      costMeta: meta || null,
    },
  };
}

function applyMinGreenExitRules({
  trade,
  ltp,
  underlyingLtp,
  now,
  env,
  basePlan,
  entry,
  sl0,
  side,
  tick,
  candles,
  quoteSnapshot,
}) {
  const qty = Number(trade?.qty ?? trade?.initialQty ?? 0);
  const minGreenEnabled = String(env.MIN_GREEN_ENABLED || "true") === "true";
  const minGreenInr = minGreenEnabled ? Number(trade?.minGreenInr ?? 0) : 0;
  const minGreenPts = minGreenEnabled ? Number(trade?.minGreenPts ?? 0) : 0;

  const curSL = Number(trade?.stopLoss ?? sl0);
  let newSL =
    basePlan?.sl?.stopLoss && Number.isFinite(basePlan.sl.stopLoss)
      ? Number(basePlan.sl.stopLoss)
      : curSL;

  const tradePatch = { ...(basePlan?.tradePatch || {}) };

  const pnlInr = unrealizedPnlInr({ side, entry, ltp, qty });
  const riskPerTradeInr = Number(trade?.riskInr ?? env.RISK_PER_TRADE_INR ?? 0);
  const pnlR =
    Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0
      ? pnlInr / riskPerTradeInr
      : null;
  const priceRisk = Math.abs(entry - sl0);
  const pnlPriceR = profitR({ side, entry, ltp, risk: priceRisk });
  const maxSpreadBpsForPeak = Number(env.MAX_SPREAD_BPS_FOR_PEAK_UPDATE ?? 80);
  const maxQuoteAgeMsForPeak = Number(env.MAX_QUOTE_AGE_MS_FOR_PEAK_UPDATE ?? 1500);
  const pxInfo = getEffectivePrice(
    {
      ...(quoteSnapshot || {}),
      ltp,
    },
    { nowMs: now, maxSpreadBps: maxSpreadBpsForPeak, maxQuoteAgeMs: maxQuoteAgeMsForPeak },
  );
  const effectivePx = Number(pxInfo?.effectivePrice);
  const peakLtpNow = bestPeakLtp({ trade, ltp: effectivePx, side });
  const peakPnlFromPriceInr = Number.isFinite(peakLtpNow)
    ? unrealizedPnlInr({ side, entry, ltp: peakLtpNow, qty })
    : null;
  const prevPeakPnlInr = toFiniteOrNaN(trade?.peakPnlInr);
  const peakPnlInr = Number.isFinite(prevPeakPnlInr)
    ? Math.max(prevPeakPnlInr, pnlInr, toFiniteOrNaN(peakPnlFromPriceInr))
    : Math.max(pnlInr, toFiniteOrNaN(peakPnlFromPriceInr));
  const peakPnlR =
    Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0
      ? peakPnlInr / riskPerTradeInr
      : null;
  const peakPriceR = Number.isFinite(peakLtpNow)
    ? profitR({ side, entry, ltp: peakLtpNow, risk: priceRisk })
    : null;
  const mfeR = Math.max(toFiniteOrNaN(peakPnlR), toFiniteOrNaN(peakPriceR));
  const peakRForRules = Number.isFinite(mfeR)
    ? mfeR
    : Number.isFinite(peakPnlR)
      ? peakPnlR
      : peakPriceR;
  const pnlRForRules = Number.isFinite(pnlR) ? pnlR : pnlPriceR;
  if (!Number.isFinite(prevPeakPnlInr) || Math.abs(peakPnlInr - prevPeakPnlInr) >= Math.max(1, tick * qty)) {
    tradePatch.peakPnlInr = peakPnlInr;
  }

  const timeStopMin = Number(env.TIME_STOP_MIN ?? 0);
  const noProgressMin = Number(env.TIME_STOP_NO_PROGRESS_MIN ?? 0);
  const noProgressMfeR = Number(env.TIME_STOP_NO_PROGRESS_MFE_R ?? 0.2);
  const noProgressUnderlyingConfirm =
    String(
      env.TIME_STOP_NO_PROGRESS_REQUIRE_UL_CONFIRM ||
        env.TIME_STOP_NO_PROGRESS_UNDERLYING_CONFIRM ||
        "true",
    ) === "true";
  const noProgressUnderlyingConfirmEffective =
    noProgressUnderlyingConfirm && isOptionTrade(trade);
  const noProgressUnderlyingMode = String(
    env.TIME_STOP_NO_PROGRESS_UL_MODE || "STRICT",
  )
    .trim()
    .toUpperCase();
  const noProgressUnderlyingBps = Number(
    env.TIME_STOP_NO_PROGRESS_UL_BPS ??
      env.TIME_STOP_NO_PROGRESS_UNDERLYING_MFE_BPS ??
      12,
  );
  const maxHoldMin = Number(env.TIME_STOP_MAX_HOLD_MIN ?? 0);
  const maxHoldSkipIfPnlR = Number(env.TIME_STOP_MAX_HOLD_SKIP_IF_PNL_R ?? 0.8);
  const maxHoldSkipIfPeakR = Number(
    env.TIME_STOP_MAX_HOLD_SKIP_IF_PEAK_R ?? env.TIME_STOP_MAX_HOLD_SKIP_IF_PEAK_PNL_R ?? 1.0,
  );
  const maxHoldSkipIfLocked =
    String(env.TIME_STOP_MAX_HOLD_SKIP_IF_LOCKED || "true") !== "false";
  const proTimeStopsEnabled =
    (Number.isFinite(noProgressMin) && noProgressMin > 0) ||
    (Number.isFinite(maxHoldMin) && maxHoldMin > 0);
  const entryTs =
    tsFrom(trade?.entryFilledAt) ||
    tsFrom(trade?.createdAt || trade?.updatedAt) ||
    now;
  const holdMin = Math.max(0, (now - entryTs) / (60 * 1000));
  const timeStopAtMs =
    Number.isFinite(timeStopMin) && timeStopMin > 0
      ? entryTs + timeStopMin * 60 * 1000
      : null;
  const timeStopLatched = Boolean(trade?.timeStopTriggeredAt);

  const beArmR = Number(env.BE_ARM_R ?? 0.6);
  const beArmCostMult = Number(env.BE_ARM_COST_MULT ?? 2.0);
  const trailArmR = Number(env.TRAIL_ARM_R ?? 1.0);
  const pnlStepInr = Number.isFinite(qty) && qty > 0 && Number.isFinite(tick) && tick > 0
    ? qty * tick
    : 0;
  const estCostInr = toFiniteOrNaN(basePlan?.meta?.trueBEMeta?.estCostInr);
  const beLockAtFromR =
    Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0 ? beArmR * riskPerTradeInr : null;
  const beLockAtFromCost =
    Number.isFinite(estCostInr) && estCostInr > 0 && Number.isFinite(beArmCostMult) && beArmCostMult > 0
      ? beArmCostMult * estCostInr
      : null;
  const beLockAt = Math.max(
    Number.isFinite(beLockAtFromR) ? beLockAtFromR : 0,
    Number.isFinite(beLockAtFromCost) ? beLockAtFromCost : 0,
  );
  const trailStartInr =
    Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0
      ? trailArmR * riskPerTradeInr
      : env.RISK_BUDGET_ENABLED
        ? 0
        : Number(env.DYN_TRAIL_START_PROFIT_INR ?? 0);
  const beArmEpsInr = pnlStepInr;
  const trailArmEpsInr = pnlStepInr;

  const beLockedForMaxHold =
    Boolean(tradePatch.beLocked || trade?.beLocked) ||
    meetsThreshold(pnlInr, beLockAt, beArmEpsInr);
  const trailLockedForMaxHold =
    Boolean(tradePatch.trailLocked || trade?.trailLocked) ||
    meetsThreshold(pnlInr, trailStartInr, trailArmEpsInr);

  const underlyingMoveBpsNow = underlyingMoveBps({ trade, underlyingLtp });
  const absUnderlyingMoveBps = Number.isFinite(underlyingMoveBpsNow)
    ? Math.abs(underlyingMoveBpsNow)
    : null;
  const prevPeakUnderlyingMoveBps = toFiniteOrNaN(trade?.peakUnderlyingMoveBps);
  const peakUnderlyingMoveBps = Number.isFinite(prevPeakUnderlyingMoveBps)
    ? Math.max(prevPeakUnderlyingMoveBps, toFiniteOrNaN(absUnderlyingMoveBps))
    : absUnderlyingMoveBps;
  const hasUnderlyingMove = Number.isFinite(absUnderlyingMoveBps);
  const noProgressUnderlyingSatisfied =
    !noProgressUnderlyingConfirmEffective ||
    !Number.isFinite(noProgressUnderlyingBps) ||
    (hasUnderlyingMove && absUnderlyingMoveBps < noProgressUnderlyingBps) ||
    (!hasUnderlyingMove &&
      noProgressUnderlyingMode === "PRICE_ONLY_ON_UNKNOWN");
  if (
    Number.isFinite(peakUnderlyingMoveBps) &&
    (!Number.isFinite(prevPeakUnderlyingMoveBps) ||
      Math.abs(peakUnderlyingMoveBps - prevPeakUnderlyingMoveBps) >= 0.5)
  ) {
    tradePatch.peakUnderlyingMoveBps = peakUnderlyingMoveBps;
  }

  if (
    !timeStopLatched &&
    !proTimeStopsEnabled &&
    Number.isFinite(timeStopAtMs) &&
    now >= timeStopAtMs &&
    pnlInr < minGreenInr
  ) {
    return {
      ...basePlan,
      ok: true,
      action: { exitNow: true, reason: "TIME_STOP" },
      tradePatch: {
        ...tradePatch,
        ...(trade?.timeStopTriggeredAt
          ? {}
          : { timeStopTriggeredAt: new Date(now) }),
      },
      meta: {
        ...(basePlan?.meta || {}),
        timeStopAtMs,
        pnlInr,
        minGreenInr,
        timeStopKind: "LEGACY",
        holdMin,
        peakPnlInr,
        peakPnlR,
      },
    };
  }

  if (
    !timeStopLatched &&
    proTimeStopsEnabled &&
    Number.isFinite(noProgressMin) &&
    noProgressMin > 0 &&
    holdMin >= noProgressMin &&
    Number.isFinite(noProgressMfeR) &&
    Number.isFinite(mfeR) &&
    mfeR < noProgressMfeR &&
    noProgressUnderlyingSatisfied
  ) {
    return {
      ...basePlan,
      ok: true,
      action: { exitNow: true, reason: "TIME_STOP_NO_PROGRESS" },
      tradePatch: {
        ...tradePatch,
        ...(trade?.timeStopTriggeredAt
          ? {}
          : { timeStopTriggeredAt: new Date(now) }),
      },
      meta: {
        ...(basePlan?.meta || {}),
        timeStopKind: "NO_PROGRESS",
        holdMin,
        noProgressMin,
        noProgressMfeR,
        noProgressUnderlyingConfirm: noProgressUnderlyingConfirmEffective,
        noProgressUnderlyingBps,
        noProgressUnderlyingStatus: noProgressUnderlyingConfirmEffective
          ? hasUnderlyingMove
            ? "KNOWN"
            : "UNKNOWN"
          : "BYPASSED",
        noProgressUnderlyingMode,
        mfeR,
        underlyingMoveBps: underlyingMoveBpsNow,
        absUnderlyingMoveBps,
        peakUnderlyingMoveBps,
        peakPnlInr,
        peakPnlR,
        peakPriceR,
        pnlInr,
        pnlR,
        pnlPriceR,
      },
    };
  }

  const maxHoldActive =
    !timeStopLatched &&
    proTimeStopsEnabled &&
    Number.isFinite(maxHoldMin) &&
    maxHoldMin > 0 &&
    holdMin >= maxHoldMin;

  if (maxHoldActive) {
    let maxHoldSkipReason = null;
    if (Number.isFinite(pnlRForRules) && pnlRForRules >= maxHoldSkipIfPnlR) {
      maxHoldSkipReason = "PNL_R";
    } else if (Number.isFinite(peakRForRules) && peakRForRules >= maxHoldSkipIfPeakR) {
      maxHoldSkipReason = "PEAK_R";
    } else if (maxHoldSkipIfLocked && (beLockedForMaxHold || trailLockedForMaxHold)) {
      maxHoldSkipReason = "LOCKED";
    }

    if (maxHoldSkipReason) {
      return {
        ...basePlan,
        meta: {
          ...(basePlan?.meta || {}),
          maxHoldSkipReason,
          maxHoldMin,
          maxHoldSkipIfPnlR,
          maxHoldSkipIfPeakR,
          maxHoldSkipIfLocked,
          holdMin,
          pnlRForRules,
          peakPnlR,
          peakRForRules,
          beLockedForMaxHold,
          trailLockedForMaxHold,
        },
      };
    }

    return {
      ...basePlan,
      ok: true,
      action: { exitNow: true, reason: "TIME_STOP_MAX_HOLD" },
      tradePatch: {
        ...tradePatch,
        ...(trade?.timeStopTriggeredAt
          ? {}
          : { timeStopTriggeredAt: new Date(now) }),
      },
      meta: {
        ...(basePlan?.meta || {}),
        timeStopKind: "MAX_HOLD",
        holdMin,
        maxHoldMin,
        maxHoldSkipIfPnlR,
        maxHoldSkipIfPeakR,
        maxHoldSkipIfLocked,
        pnlInr,
        pnlR,
        pnlPriceR,
        pnlRForRules,
        peakPnlInr,
        peakPnlR,
        peakRForRules,
        peakPriceR,
      },
    };
  }

  let beLockArmed = Boolean(trade?.beLocked);
  let beLockFiredThisTick = false;
  const beAppliedAtTs = tsFrom(trade?.beAppliedAt);
  const beAppliedStopLoss = toFiniteOrNaN(trade?.beAppliedStopLoss);
  let beApplied = Number.isFinite(beAppliedAtTs) && Number.isFinite(beAppliedStopLoss);
  let trailArmed = Boolean(trade?.trailLocked);
  const skipReasons = [];

  if (meetsThreshold(pnlInr, beLockAt, beArmEpsInr)) {
    beLockArmed = true;
  }
  if (meetsThreshold(pnlInr, trailStartInr, trailArmEpsInr)) {
    trailArmed = true;
  }

  if (beLockArmed && !trade?.beLocked) {
    beLockFiredThisTick = true;
    tradePatch.beLocked = true;
    tradePatch.beLockedAt = new Date(now);
  }
  if (beLockArmed) {
    tradePatch.beArmed = true;
    if (!trade?.beFiredTs) tradePatch.beFiredTs = tradePatch.beLockedAt || new Date(now);
  }
  if (trailArmed && !trade?.trailLocked) {
    tradePatch.trailLocked = true;
    tradePatch.trailLockedAt = new Date(now);
  }

  // Latched behaviour: once armed, these states must remain active until trade closes.
  const beLockedNow = Boolean(tradePatch.beLocked || trade?.beLocked || beLockArmed);
  const beJustLockedNow = Boolean(beLockedNow && !trade?.beLocked);
  const trailLockedNow = Boolean(tradePatch.trailLocked || trade?.trailLocked || trailArmed);

  const allowTrail = beLockedNow || trailLockedNow || trade?.tp1Done;

  const trailGapPreBePct = Number(env.TRAIL_GAP_PRE_BE_PCT ?? 0.08);
  const trailGapPostBePct = Number(env.TRAIL_GAP_POST_BE_PCT ?? 0.04);
  const trailTightenR = Number(env.TRAIL_TIGHTEN_R ?? 1.5);
  const trailGapPostBePctTight = Number(env.TRAIL_GAP_POST_BE_PCT_TIGHT ?? trailGapPostBePct);
  const trailGapMinPts = Number(env.TRAIL_GAP_MIN_PTS ?? 2);
  const trailGapMaxPts = Number(env.TRAIL_GAP_MAX_PTS ?? 10);
  const beBufferTicks = safeNum(env.BE_BUFFER_TICKS, safeNum(env.DYN_BE_BUFFER_TICKS, 1));
  const triggerBufferTicks = Number(env.TRIGGER_BUFFER_TICKS ?? 1);

  const trueBE = toFiniteOrNaN(basePlan?.meta?.trueBE);
  let beFloor = null;
  let beProfitLockFloor = null;
  if (beLockedNow && Number.isFinite(trueBE)) {
    const raw = side === "BUY" ? trueBE + beBufferTicks * tick : trueBE - beBufferTicks * tick;
    beFloor = roundToTick(raw, tick, side === "BUY" ? "up" : "down");
    if (side === "BUY") {
      newSL = Math.max(newSL, beFloor);
    } else {
      newSL = Math.min(newSL, beFloor);
    }
    if (!trade?.beLockedAtPrice) {
      tradePatch.beLockedAtPrice = beFloor;
    }
  }

  if (
    !beApplied &&
    beLockedNow &&
    Number.isFinite(curSL) &&
    Number.isFinite(beFloor)
  ) {
    beApplied = side === "BUY" ? curSL >= beFloor : curSL <= beFloor;
  }

  if (beLockedNow && Number.isFinite(entry) && Number.isFinite(qty) && qty > 0) {
    const beLockKeepR = Number(env.BE_PROFIT_LOCK_KEEP_R ?? env.PROFIT_LOCK_KEEP_R ?? 0.25);
    const beLockCostMult = Number(env.BE_PROFIT_LOCK_COST_MULT ?? env.PROFIT_LOCK_COST_MULT ?? 1.0);
    const lockByR =
      Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0 && Number.isFinite(beLockKeepR) && beLockKeepR > 0
        ? beLockKeepR * riskPerTradeInr
        : 0;
    const lockByCost =
      Number.isFinite(estCostInr) && estCostInr > 0 && Number.isFinite(beLockCostMult) && beLockCostMult > 0
        ? beLockCostMult * estCostInr
        : 0;
    const lockInr = Math.max(lockByR, lockByCost);
    if (Number.isFinite(lockInr) && lockInr > 0) {
      const lockPts = lockInr / qty;
      const raw = side === "BUY" ? entry + lockPts : entry - lockPts;
      beProfitLockFloor = roundToTick(raw, tick, side === "BUY" ? "up" : "down");
      if (side === "BUY") {
        newSL = Math.max(newSL, beProfitLockFloor);
      } else {
        newSL = Math.min(newSL, beProfitLockFloor);
      }
      tradePatch.beProfitLockInr = lockInr;
      tradePatch.beProfitLockKeepR = beLockKeepR;
      tradePatch.beProfitLockCostMult = beLockCostMult;
      if (!trade?.beLockedAtPrice) {
        tradePatch.beLockedAtPrice = beProfitLockFloor;
      }
    }
  }

  const profitLockEnabled = String(env.PROFIT_LOCK_ENABLED || "false") === "true";
  const profitLockR = Number(env.PROFIT_LOCK_R ?? 1.0);
  const profitLockKeepR = Number(env.PROFIT_LOCK_KEEP_R ?? 0.25);
  const profitLockArmed =
    profitLockEnabled && Number.isFinite(mfeR) && mfeR >= profitLockR;
  if (profitLockArmed && !trade?.profitLockArmedAt) {
    tradePatch.profitLockArmedAt = new Date(now);
  }
  if (profitLockArmed && Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0 && qty > 0) {
    const lockInr = profitLockKeepR * riskPerTradeInr;
    if (Number.isFinite(lockInr) && lockInr > 0) {
      const lockPts = lockInr / qty;
      const lockSlRaw = side === "BUY" ? entry + lockPts : entry - lockPts;
      const lockSl = roundToTick(lockSlRaw, tick, side === "BUY" ? "up" : "down");
      if (side === "BUY") newSL = Math.max(newSL, lockSl);
      else newSL = Math.min(newSL, lockSl);
      tradePatch.profitLockInr = lockInr;
      tradePatch.profitLockR = profitLockKeepR;
    }
  }

  let trailGap = null;

  if (
    allowTrail &&
    Number.isFinite(ltp)
  ) {
    const prevPeak = toFiniteOrNaN(trade?.peakLtp);
    let peakLtp = prevPeak;
    const recent = Array.isArray(trade?.recentEffectivePx) ? trade.recentEffectivePx.slice(-10) : [];
    if (Number.isFinite(effectivePx)) recent.push(effectivePx);
    const avg = recent.length ? recent.reduce((a, b) => a + Number(b || 0), 0) / recent.length : null;
    const variance = recent.length
      ? recent.reduce((acc, n) => acc + (Number(n || 0) - avg) ** 2, 0) / recent.length
      : null;
    const sigma = Number.isFinite(variance) ? Math.sqrt(variance) : null;
    const outlierEnabled = String(env.PEAK_OUTLIER_FILTER || "true") === "true";
    const outlierSigma = Number(env.PEAK_OUTLIER_SIGMA_MULT ?? 3.0);
    const isOutlier =
      outlierEnabled &&
      Number.isFinite(effectivePx) &&
      Number.isFinite(avg) &&
      Number.isFinite(sigma) &&
      sigma > 0 &&
      Math.abs(effectivePx - avg) > outlierSigma * sigma;
    const canUseForPeak = Boolean(Number.isFinite(effectivePx) && pxInfo?.spreadOk && pxInfo?.ageOk && !isOutlier);

    if (side === "BUY" && canUseForPeak) {
      peakLtp = Number.isFinite(prevPeak) ? Math.max(prevPeak, effectivePx) : effectivePx;
    } else if (side === "SELL" && canUseForPeak) {
      peakLtp = Number.isFinite(prevPeak) ? Math.min(prevPeak, effectivePx) : effectivePx;
    }
    const shouldTightenTrail =
      Number.isFinite(peakRForRules) &&
      Number.isFinite(trailTightenR) &&
      peakRForRules >= trailTightenR;
    const gapPct = beLockedNow
      ? shouldTightenTrail
        ? trailGapPostBePctTight
        : trailGapPostBePct
      : trailGapPreBePct;
    const rawGap = clamp(peakLtp * gapPct, trailGapMinPts, trailGapMaxPts);
    trailGap = roundToTick(rawGap, tick, "nearest");
    if (!(Number.isFinite(trailGap) && trailGap > 0)) {
      trailGap = null;
    }

    const trailSl =
      Number.isFinite(trailGap) && trailGap > 0
        ? side === "BUY"
          ? peakLtp - trailGap
          : peakLtp + trailGap
        : null;
    if (!Number.isFinite(prevPeak) || peakLtp !== prevPeak) {
      tradePatch.peakLtp = peakLtp;
    }
    if (recent.length) tradePatch.recentEffectivePx = recent.slice(-10);
    const curTrailSl = Number(trade?.trailSl);
    if (
      Number.isFinite(trailSl) &&
      (!Number.isFinite(curTrailSl) || Math.abs(trailSl - curTrailSl) >= tick / 2)
    ) {
      tradePatch.trailSl = trailSl;
    }

    if (Number.isFinite(trailSl)) {
      if (beLockedNow && Number.isFinite(beFloor)) {
        newSL = side === "BUY" ? Math.max(newSL, beFloor, trailSl) : Math.min(newSL, beFloor, trailSl);
      } else if (side === "BUY") {
        newSL = Math.max(newSL, trailSl);
      } else {
        newSL = Math.min(newSL, trailSl);
      }
    }
  }

  // Never loosen beyond initial SL (unless controlled early widen for options)
  const allowWiden =
    isOptionTrade(trade) &&
    Number.isFinite(entry) &&
    String(env.OPT_EXIT_ALLOW_WIDEN_SL || "true") === "true" &&
    holdMin <= Number(env.OPT_EXIT_WIDEN_WINDOW_MIN ?? 2);

  const baseRiskInr = Number(trade?.riskInr ?? 0);
  const widenMult = Number(env.OPT_EXIT_WIDEN_MAX_RISK_MULT ?? 1.3);
  const maxRiskInr =
    allowWiden && Number.isFinite(baseRiskInr) && baseRiskInr > 0
      ? baseRiskInr * Math.max(1, widenMult)
      : null;
  const maxRiskPts =
    Number.isFinite(maxRiskInr) && qty > 0 ? maxRiskInr / qty : null;

  if (Number.isFinite(sl0)) {
    if (side === "BUY") {
      const minAllowed =
        allowWiden && Number.isFinite(maxRiskPts)
          ? Math.min(sl0, entry - maxRiskPts)
          : sl0;
      newSL = Math.max(newSL, minAllowed);
    } else {
      const maxAllowed =
        allowWiden && Number.isFinite(maxRiskPts)
          ? Math.max(sl0, entry + maxRiskPts)
          : sl0;
      newSL = Math.min(newSL, maxAllowed);
    }
  }

  // Broker-valid guard: SL should not be beyond market
  const buffer = tick;
  if (Number.isFinite(ltp)) {
    if (side === "BUY") newSL = clamp(newSL, undefined, ltp - buffer);
    else newSL = clamp(newSL, ltp + buffer, undefined);
  }

  newSL = roundToTick(newSL, tick, side === "BUY" ? "down" : "up");

  const stepTicks = Number(
    beLockedNow
      ? env.DYN_STEP_TICKS_POST_BE ?? env.DYN_TRAIL_STEP_TICKS ?? 10
      : env.DYN_STEP_TICKS_PRE_BE ?? env.DYN_TRAIL_STEP_TICKS ?? 20,
  );
  let adaptiveStepTicks = stepTicks;
  if (String(env.DYN_STEP_VOL_ADAPT || "false") === "true") {
    const lookback = Number(env.DYN_STEP_VOL_LOOKBACK ?? 20);
    const vol = premiumVolPct(candles, lookback);
    const baseVol = Number(env.DYN_STEP_VOL_BASE_PCT ?? 1.2);
    const minMult = Number(env.DYN_STEP_VOL_MIN_MULT ?? 0.5);
    const maxMult = Number(env.DYN_STEP_VOL_MAX_MULT ?? 1.2);
    const factor = Number.isFinite(vol) && Number.isFinite(baseVol) && baseVol > 0 ? vol / baseVol : 1;
    adaptiveStepTicks = stepTicks * clamp(factor, minMult, maxMult);
  }
  const step = adaptiveStepTicks * tick;
  const curSlRounded = roundToTick(curSL, tick, side === "BUY" ? "down" : "up");
  const desiredStopLoss = roundToTick(newSL, tick, side === "BUY" ? "down" : "up");
  const tightenDelta = side === "BUY"
    ? desiredStopLoss - curSlRounded
    : curSlRounded - desiredStopLoss;
  const curSlBelowBeFloor =
    Number.isFinite(curSlRounded) &&
    Number.isFinite(beFloor) &&
    (side === "BUY" ? curSlRounded < beFloor : curSlRounded > beFloor);
  const lockCandidates = [beFloor, beProfitLockFloor, curSL].map((v) => Number(v)).filter((v) => Number.isFinite(v));
  const activeLockFloorPrice = !lockCandidates.length
    ? null
    : side === "BUY"
      ? Math.max(...lockCandidates)
      : Math.min(...lockCandidates);
  const forceBePriorityMove = Boolean(!beApplied && beLockedNow && curSlBelowBeFloor);
  const shouldForceApply = forceBePriorityMove || (Number.isFinite(activeLockFloorPrice) && Number.isFinite(desiredStopLoss) && (side === "BUY" ? desiredStopLoss <= activeLockFloorPrice : desiredStopLoss >= activeLockFloorPrice));

  const prevPendingMove = Number(trade?.trailPendingMove ?? 0);
  const pendingBase = Number.isFinite(prevPendingMove) && prevPendingMove > 0 ? prevPendingMove : 0;
  const pendingMove = Math.max(0, pendingBase + (Number.isFinite(tightenDelta) && tightenDelta > 0 ? tightenDelta : 0));
  let stepsToMove = Number.isFinite(step) && step > 0 ? Math.floor(pendingMove / step) : 0;
  let moveBy = stepsToMove > 0 ? stepsToMove * step : 0;

  let effectiveDesiredStopLoss = desiredStopLoss;
  if (!forceBePriorityMove && moveBy > 0 && Number.isFinite(curSlRounded)) {
    effectiveDesiredStopLoss = roundToTick(
      side === "BUY" ? curSlRounded + moveBy : curSlRounded - moveBy,
      tick,
      side === "BUY" ? "down" : "up",
    );
  }

  const slMove = side === "BUY"
    ? effectiveDesiredStopLoss - curSlRounded
    : curSlRounded - effectiveDesiredStopLoss;
  const shouldMoveSL = (Number.isFinite(slMove) && slMove > 0) || forceBePriorityMove;
  const nextPendingMove = forceBePriorityMove
    ? 0
    : (stepsToMove > 0 ? Math.max(0, pendingMove - moveBy) : pendingMove);
  if (Math.abs(nextPendingMove - prevPendingMove) >= Math.max(tick, 0.01)) {
    tradePatch.trailPendingMove = nextPendingMove;
  }

  if (!beLockedNow) {
    if (!(Number.isFinite(beLockAt) && beLockAt > 0)) skipReasons.push("be_lock_disabled");
    else if (!meetsThreshold(pnlInr, beLockAt, beArmEpsInr))
      skipReasons.push(
        `pnlInr=${Number(pnlInr ?? 0).toFixed(2)} < beLockAt=${beLockAt} (eps=${Number(beArmEpsInr ?? 0).toFixed(2)})`,
      );
  }

  if (!allowTrail) {
    skipReasons.push("trail_not_armed");
  } else if (!(Number.isFinite(trailGap) && trailGap > 0)) {
    skipReasons.push("trail_gap_disabled");
  }

  if (!trailLockedNow) {
    if (!(Number.isFinite(trailStartInr) && trailStartInr > 0)) skipReasons.push("trail_arm_disabled");
    else if (!allowTrail) {
      skipReasons.push(`pnlInr=${Number(pnlInr ?? 0).toFixed(2)} < trailStartInr=${trailStartInr}`);
    }
  }

  let finalStopLoss = shouldMoveSL
    ? roundToTick(
        side === "BUY"
          ? effectiveDesiredStopLoss + triggerBufferTicks * tick
          : effectiveDesiredStopLoss - triggerBufferTicks * tick,
        tick,
        side === "BUY" ? "up" : "down",
      )
    : null;

  // Keep post-buffer trigger broker-valid relative to live LTP.
  if (shouldMoveSL && Number.isFinite(ltp) && Number.isFinite(finalStopLoss)) {
    if (side === "BUY") {
      finalStopLoss = Math.min(finalStopLoss, ltp - tick);
      finalStopLoss = roundToTick(finalStopLoss, tick, "down");
    } else {
      finalStopLoss = Math.max(finalStopLoss, ltp + tick);
      finalStopLoss = roundToTick(finalStopLoss, tick, "up");
    }
  }

  if (Number.isFinite(activeLockFloorPrice)) {
    tradePatch.activeLockFloorPrice = activeLockFloorPrice;
  }

  if (forceBePriorityMove) {
    skipReasons.push("be_priority_sl_move");
  } else if (!shouldMoveSL) {
    skipReasons.push(`sl_move_below_step (move=${Number(slMove ?? 0).toFixed(2)}, step=${Number(step ?? 0).toFixed(2)}, pending=${Number(nextPendingMove ?? 0).toFixed(2)})`);
  }

  return {
    ...basePlan,
    ok: true,
    sl: shouldMoveSL ? { stopLoss: finalStopLoss } : basePlan?.sl || null,
    tradePatch,
    meta: {
      ...(basePlan?.meta || {}),
      pnlInr,
      minGreenInr,
      minGreenPts,
      pnlR,
      pnlPriceR,
      pnlRForRules,
      peakPnlInr,
      peakPnlR,
      peakPriceR,
      mfeR,
      beLockAt,
      beLockAtFromR: Number.isFinite(beLockAtFromR) ? beLockAtFromR : null,
      beLockAtFromCost: Number.isFinite(beLockAtFromCost) ? beLockAtFromCost : null,
      beArmCostMult,
      beArmEpsInr,
      trailGap,
      trailStartInr: Number.isFinite(trailStartInr) ? trailStartInr : null,
      trailArmEpsInr,
      allowTrail,
      beLockArmed: beLockedNow,
      beLockFiredThisTick,
      trailArmed: trailLockedNow,
      beArmR,
      trailArmR,
      riskPerTradeInr,
      trueBE: Number.isFinite(trueBE) ? trueBE : null,
      beFloor,
      beProfitLockFloor,
      beArmed: beLockedNow,
      beFiredTs: tradePatch.beLockedAt || trade?.beLockedAt || null,
      activeLockFloorPrice: Number.isFinite(activeLockFloorPrice) ? activeLockFloorPrice : null,
      effectivePrice: Number.isFinite(effectivePx) ? effectivePx : null,
      effectivePriceSource: pxInfo?.source || null,
      spreadBps: Number.isFinite(pxInfo?.spreadBps) ? pxInfo.spreadBps : null,
      quoteAgeMs: Number.isFinite(pxInfo?.quoteAgeMs) ? pxInfo.quoteAgeMs : null,
      shouldForceApply,
      reasonCodes: skipReasons,
      estCostInr: Number.isFinite(estCostInr) ? estCostInr : null,
      desiredStopLoss: effectiveDesiredStopLoss,
      finalStopLoss,
      triggerBufferTicks,
      peakLtp: Number(tradePatch?.peakLtp ?? trade?.peakLtp),
      skipReason: skipReasons.join(" | ") || null,
      holdMin,
      allowWiden,
      profitLockArmed,
      profitLockR,
      profitLockKeepR,
      profitLockMinInr,
      trailTightenR,
      trailGapPostBePctTight,
      pendingMove: nextPendingMove,
      trailStep: step,
      stepTicksApplied: adaptiveStepTicks,
      widenMult: Number.isFinite(widenMult) ? widenMult : null,
      maxRiskInr: Number.isFinite(maxRiskInr) ? maxRiskInr : null,
      maxRiskPts: Number.isFinite(maxRiskPts) ? maxRiskPts : null,
    },
  };
}

function premiumVolPct(candles, lookback = 20) {
  if (!Array.isArray(candles) || candles.length < 4) return null;
  const n = Math.max(4, Math.min(Number(lookback ?? 20), 120));
  const tail = candles.slice(-n);
  const rets = [];
  for (let i = 1; i < tail.length; i += 1) {
    const a = safeNum(tail[i - 1]?.close);
    const b = safeNum(tail[i]?.close);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) continue;
    const r = Math.abs(b - a) / a;
    if (Number.isFinite(r)) rets.push(r);
  }
  if (!rets.length) return null;
  // mean absolute return per candle (percent)
  const avg = (rets.reduce((x, y) => x + y, 0) / rets.length) * 100;
  return Number.isFinite(avg) ? avg : null;
}

function underlyingMoveBps({ trade, underlyingLtp }) {
  const uEntry = safeNum(
    trade?.underlying_ltp ?? trade?.option_meta?.underlyingLtp,
  );
  const uNow = safeNum(underlyingLtp);
  if (!(uEntry > 0) || !(uNow > 0)) return null;
  return ((uNow - uEntry) / uEntry) * 10000;
}

function optionHybridTrailGap({ trade, ltp, env, trailPct, tick }) {
  const pctGap = Number.isFinite(trailPct) && trailPct > 0
    ? (Number(ltp) * trailPct) / 100
    : NaN;

  const atrU = safeNum(
    trade?.regimeMeta?.atr ??
      trade?.marketContextAtEntry?.atr ??
      trade?.planMeta?.regimeMeta?.atr,
  );
  const atrMult = Math.max(0, Number(env.OPT_EXIT_HYBRID_ATR_MULT ?? 1.0));
  const moveU = Number.isFinite(atrU) && atrU > 0 ? atrU * atrMult : NaN;

  const deltaAbs = Math.abs(Number(trade?.option_meta?.delta));
  const delta = Number.isFinite(deltaAbs) && deltaAbs > 0
    ? deltaAbs
    : Number(env.OPT_DELTA_ATM ?? 0.5);
  const gammaRaw = Math.abs(Number(trade?.option_meta?.gamma));
  const gamma = Number.isFinite(gammaRaw) ? gammaRaw : 0;

  const atrGap =
    Number.isFinite(moveU) && moveU > 0
      ? moveU * delta + 0.5 * gamma * moveU * moveU
      : NaN;

  const w = clamp(Number(env.OPT_EXIT_HYBRID_WEIGHT ?? 0.7), 0, 1);
  let hybridGap = NaN;
  if (Number.isFinite(atrGap) && Number.isFinite(pctGap)) {
    hybridGap = atrGap * w + pctGap * (1 - w);
  } else if (Number.isFinite(atrGap)) {
    hybridGap = atrGap;
  } else if (Number.isFinite(pctGap)) {
    hybridGap = pctGap;
  }

  const minTicks = Math.max(1, Number(env.OPT_EXIT_HYBRID_MIN_TICKS ?? 2));
  const minGap = Math.max(tick, minTicks * tick);
  if (Number.isFinite(hybridGap)) hybridGap = Math.max(minGap, hybridGap);

  return {
    gap: Number.isFinite(hybridGap) ? hybridGap : null,
    meta: {
      pctGap: Number.isFinite(pctGap) ? pctGap : null,
      atrU: Number.isFinite(atrU) ? atrU : null,
      atrMult,
      moveU: Number.isFinite(moveU) ? moveU : null,
      delta,
      gamma,
      atrGap: Number.isFinite(atrGap) ? atrGap : null,
      weight: w,
      minGap,
    },
  };
}

function optionExitFallback({
  trade,
  ltp,
  candles,
  nowTs,
  env,
  underlyingLtp,
  beInfo,
}) {
  const side = String(trade.side || "").toUpperCase();
  const tick = Number(trade.instrument?.tick_size ?? 0.05);

  const { entry, sl0 } = computeBaseRisk(trade);
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(ltp) ||
    ltp <= 0
  )
    return { ok: false, reason: "missing_prices" };
  if (side !== "BUY" && side !== "SELL")
    return { ok: false, reason: "invalid_side" };

  const now = Number(nowTs ?? Date.now());
  const refTs =
    tsFrom(trade.entryFilledAt) ||
    tsFrom(trade.createdAt) ||
    tsFrom(trade.updatedAt) ||
    now;
  const holdMin = Math.max(0, (now - refTs) / (60 * 1000));

  // ===== Time-based exit (hard stop) =====
  const globalMaxHold = Number(env.TIME_STOP_MAX_HOLD_MIN ?? 0);
  const proMaxHoldEnabled = Number.isFinite(globalMaxHold) && globalMaxHold > 0;
  const maxHold = Number(env.OPT_EXIT_MAX_HOLD_MIN ?? 25);
  if (!proMaxHoldEnabled && Number.isFinite(maxHold) && maxHold > 0 && holdMin >= maxHold) {
    return {
      ok: true,
      action: { exitNow: true, reason: `OPT_TIME_EXIT (>=${maxHold}m)` },
      meta: { holdMin, maxHold },
    };
  }

  // ===== Coarse "IV crush" protection =====
  // If premium is falling sharply while underlying hasn't moved much, it's often IV crush / theta bleed.
  const neutralBps = Number(env.OPT_IV_NEUTRAL_BPS ?? 12);
  const crushPct = Number(env.OPT_IV_CRUSH_PREMIUM_PCT ?? 18);
  const crushMinHold = Number(env.OPT_IV_CRUSH_MIN_HOLD_MIN ?? 3);

  const pPct = profitPct({ side, entry, ltp }); // BUY positive == profit
  const uBps = underlyingMoveBps({ trade, underlyingLtp });
  const absUBps = Number.isFinite(uBps) ? Math.abs(uBps) : null;

  if (
    Number.isFinite(absUBps) &&
    absUBps <= neutralBps &&
    Number.isFinite(crushPct) &&
    crushPct > 0 &&
    holdMin >= crushMinHold &&
    pPct <= -Math.abs(crushPct)
  ) {
    return {
      ok: true,
      action: {
        exitNow: true,
        reason: `OPT_IV_CRUSH (prem ${pPct.toFixed(1)}% | und ${uBps.toFixed(
          1,
        )}bps)`,
      },
      meta: { holdMin, pPct, uBps, neutralBps, crushPct, crushMinHold },
    };
  }

  // ===== Premium % model (w/ volatility-aware widening) =====
  const baseSlPct = Number(env.OPT_EXIT_BASE_SL_PCT ?? 18);
  const baseTpPct = Number(env.OPT_EXIT_BASE_TARGET_PCT ?? 35);
  const minSlPct = Number(env.OPT_EXIT_MIN_SL_PCT ?? 8);
  const maxSlPct = Number(env.OPT_EXIT_MAX_SL_PCT ?? env.OPT_MAX_SL_PCT ?? 35);

  const volLookback = Number(env.OPT_EXIT_VOL_LOOKBACK ?? 20);
  const volRef = Number(env.OPT_EXIT_VOL_REF_PCT ?? 6);
  const vfMin = Number(env.OPT_EXIT_WIDEN_FACTOR_MIN ?? 0.75);
  const vfMax = Number(env.OPT_EXIT_WIDEN_FACTOR_MAX ?? 1.8);

  const volPct = premiumVolPct(candles, volLookback);
  const volFactor =
    Number.isFinite(volPct) && Number.isFinite(volRef) && volRef > 0
      ? clamp(volPct / volRef, vfMin, vfMax)
      : 1.0;

  const slPct = clamp(baseSlPct * volFactor, minSlPct, maxSlPct);
  const tpPct = clamp(
    baseTpPct * volFactor,
    Math.max(10, baseTpPct * 0.6),
    120,
  );

  // Recommended model levels
  const modelSL =
    side === "BUY"
      ? roundToTick(entry * (1 - slPct / 100), tick, "down")
      : roundToTick(entry * (1 + slPct / 100), tick, "up");

  const modelTP =
    side === "BUY"
      ? roundToTick(entry * (1 + tpPct / 100), tick, "up")
      : roundToTick(entry * (1 - tpPct / 100), tick, "down");

  // Current stop/target in DB (may already be trailed)
  const curSL = safeNum(trade.stopLoss || sl0);
  const curTarget = safeNum(trade.targetPrice || 0, 0);

  let newSL = Number.isFinite(curSL) ? curSL : modelSL;
  let newTarget = curTarget > 0 ? curTarget : modelTP;

  // ===== Controlled early widening (options only) =====
  const allowWiden =
    String(env.OPT_EXIT_ALLOW_WIDEN_SL || "true") === "true" &&
    holdMin <= Number(env.OPT_EXIT_WIDEN_WINDOW_MIN ?? 2);

  if (allowWiden && Number.isFinite(curSL)) {
    // If current SL is much tighter than the model, widen it to reduce early noise stop-outs.
    // NOTE: This is the only case where we allow loosening (options-only, early window, capped).
    if (side === "BUY" && curSL > modelSL) newSL = modelSL;
    if (side === "SELL" && curSL < modelSL) newSL = modelSL;
  }

  // ===== Premium trailing (after profit threshold) =====
  const trailStartPct = Number(env.OPT_EXIT_TRAIL_START_PROFIT_PCT ?? 15);
  const baseTrailPct = Number(env.OPT_EXIT_TRAIL_PCT_BASE ?? 12);
  const trailMin = Number(env.OPT_EXIT_TRAIL_PCT_MIN ?? 6);
  const trailMax = Number(env.OPT_EXIT_TRAIL_PCT_MAX ?? 22);

  const trailPct = clamp(baseTrailPct * volFactor, trailMin, trailMax);
  const exitModel = String(env.OPT_EXIT_MODEL || "PREMIUM_PCT").toUpperCase();
  const hybrid = optionHybridTrailGap({ trade, ltp, env, trailPct, tick });
  const useHybridTrail = exitModel === "HYBRID_ATR_DELTA";

  if (Number.isFinite(trailStartPct) && pPct >= trailStartPct) {
    const trailGap = useHybridTrail && Number.isFinite(hybrid.gap)
      ? Number(hybrid.gap)
      : (ltp * trailPct) / 100;
    if (side === "BUY") {
      const trailSL = roundToTick(ltp - trailGap, tick, "down");
      newSL = Math.max(newSL, trailSL);
    } else {
      const trailSL = roundToTick(ltp + trailGap, tick, "up");
      newSL = Math.min(newSL, trailSL);
    }
  }

  // ===== IV spike heuristic: premium up a lot while underlying "neutral" =====
  // Lock profits aggressively: tighten SL and optionally place a marketable target to hit bid/ask.
  const spikePct = Number(env.OPT_IV_SPIKE_PREMIUM_PCT ?? 25);
  if (
    Number.isFinite(absUBps) &&
    absUBps <= neutralBps &&
    Number.isFinite(spikePct) &&
    pPct >= spikePct
  ) {
    const spikeTrailPct = Number(env.OPT_IV_SPIKE_TRAIL_PCT ?? 10);
    if (side === "BUY") {
      const lockSL = roundToTick(ltp * (1 - spikeTrailPct / 100), tick, "down");
      newSL = Math.max(newSL, lockSL);

      if (String(env.OPT_IV_SPIKE_TP_TO_BID || "true") === "true") {
        const bidTicks = Number(env.OPT_IV_SPIKE_TP_BID_TICKS ?? 1);
        const mktable = roundToTick(
          ltp - Math.max(1, bidTicks) * tick,
          tick,
          "down",
        );
        // Keep it profit-side & fee-safe if possible
        const minOk = Math.max(entry + tick, safeNum(beInfo?.be, entry + tick));
        newTarget = Math.min(newTarget, Math.max(mktable, minOk));
      }
    } else {
      const lockSL = roundToTick(ltp * (1 + spikeTrailPct / 100), tick, "up");
      newSL = Math.min(newSL, lockSL);

      if (String(env.OPT_IV_SPIKE_TP_TO_BID || "true") === "true") {
        const bidTicks = Number(env.OPT_IV_SPIKE_TP_BID_TICKS ?? 1);
        const mktable = roundToTick(
          ltp + Math.max(1, bidTicks) * tick,
          tick,
          "up",
        );
        const maxOk = Math.min(entry - tick, safeNum(beInfo?.be, entry - tick));
        newTarget = Math.max(newTarget, Math.min(mktable, maxOk));
      }
    }
  }

  // ===== Ensure SL doesn't cross market (avoid invalid trigger) =====
  const buffer = tick;
  if (side === "BUY") newSL = clamp(newSL, undefined, ltp - buffer);
  else newSL = clamp(newSL, ltp + buffer, undefined);
  newSL = roundToTick(newSL, tick, side === "BUY" ? "down" : "up");

  // ===== Never loosen beyond the "allowed floor" =====
  // For options, if early widening happened, the floor becomes the widened stop; afterwards, only tighten.
  const floorSL = allowWiden ? modelSL : sl0;
  if (side === "BUY") newSL = Math.max(newSL, floorSL);
  else newSL = Math.min(newSL, floorSL);

  // ===== Decide whether to send modifications =====
  const stepTicks = Number(env.DYN_TRAIL_STEP_TICKS ?? 20);
  const step = stepTicks * tick;

  const slMove = Number.isFinite(curSL)
    ? side === "BUY"
      ? newSL - curSL
      : curSL - newSL
    : Infinity;

  const shouldMoveSL = Number.isFinite(slMove) && slMove >= step;

  // Target: for options fallback, allow tightening (or the IV-spike "mktable" quick-exit) even if DYN_TARGET_MODE=STATIC.
  let shouldMoveTarget = false;
  if (Number.isFinite(newTarget) && newTarget > 0) {
    // ensure target stays on profitable side of entry
    if (side === "BUY") newTarget = Math.max(newTarget, entry + tick);
    else newTarget = Math.min(newTarget, entry - tick);

    const tMove = curTarget > 0 ? Math.abs(newTarget - curTarget) : Infinity;
    shouldMoveTarget = tMove >= step;
  } else {
    newTarget = null;
  }

  return {
    ok: true,
    sl: shouldMoveSL ? { stopLoss: newSL } : null,
    target: shouldMoveTarget ? { targetPrice: newTarget } : null,
    meta: {
      model: "OPT_PREMIUM_PCT",
      holdMin,
      entry,
      ltp,
      profitPct: pPct,
      volPct: Number.isFinite(volPct) ? volPct : null,
      volFactor,
      slPct,
      tpPct,
      exitModel,
      hybridTrail: useHybridTrail ? hybrid.meta : null,
      modelSL,
      modelTP,
      curSL: Number.isFinite(curSL) ? curSL : null,
      newSL,
      curTarget: curTarget > 0 ? curTarget : null,
      newTarget,
      uBps: Number.isFinite(uBps) ? uBps : null,
    },
  };
}

function computeDynamicExitPlan({
  trade,
  ltp,
  candles,
  nowTs,
  env,
  underlyingLtp = undefined,
  quoteSnapshot = undefined,
}) {
  const side = String(trade?.side || "").toUpperCase();
  const tick = Number(trade?.instrument?.tick_size ?? 0.05);

  const { entry, sl0, risk } = computeBaseRisk(trade);
  const rr = Number(trade?.rr ?? env.RR_TARGET ?? 1.0);

  // Required
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(ltp) ||
    ltp <= 0
  )
    return { ok: false, reason: "missing_prices" };

  const now = Number(nowTs ?? Date.now());
  const beInfo = estimateTrueBreakeven({ trade, entry, side, tick, env });

  let basePlan = null;

  // -----------------------
  // OPTIONS-AWARE FALLBACKS
  // -----------------------
  if (isOptionTrade(trade)) {
    const plan = optionExitFallback({
      trade,
      ltp,
      candles,
      nowTs: now,
      env,
      underlyingLtp,
      beInfo,
    });
    if (plan?.ok) {
      basePlan = {
        ...plan,
        meta: {
          ...(plan.meta || {}),
          at: new Date(now).toISOString(),
          side,
          tick,
          optionType: optionType(trade),
          trueBE: beInfo?.be,
          trueBEMeta: beInfo?.meta || null,
        },
      };
    }
    // If fallback couldn't build, still continue to equity-style logic below as a last resort.
  }

  // -----------------------
  // CASH / DEFAULT LOGIC
  // -----------------------
  if (!basePlan) {
    if (!candles || candles.length < 20)
      return { ok: false, reason: "not_enough_candles" };

    const pr = profitR({ side, entry, ltp, risk });

    // ---------- trailing stop ----------
    const atrPeriod = Number(env.DYN_ATR_PERIOD ?? 14);
    const a = atr(candles, atrPeriod);
    const atrMult = Number(env.DYN_TRAIL_ATR_MULT ?? 1.2);

    // Start ATR trailing only after X R in profit
    const trailStartR = Number(env.DYN_TRAIL_START_R ?? 1.0);

    // Move SL to "true breakeven" after Y R in profit
    const beAtR = Number(env.DYN_MOVE_SL_TO_BE_AT_R ?? 0.8);

    const stepTicks = Number(env.DYN_TRAIL_STEP_TICKS ?? 20); // minimum move before modifying
    const step = stepTicks * tick;

    // candles since entry
    const entryTs = tsFrom(trade.createdAt || trade.updatedAt) || Date.now();
    const since = candles.filter((c) => {
      const ts = tsFrom(c?.ts) || tsFrom(c?.time) || null;
      return Number.isFinite(ts) && ts >= entryTs;
    });
    const slice = since.length ? since : candles.slice(-60);

    const hi = maxHigh(slice);
    const lo = minLow(slice);

    // Current stop in DB (may already be trailed)
    const curSL = Number(trade.stopLoss ?? sl0);
    let newSL = curSL;

    // Break-even move (fee-safe BE)
    if (risk > 0 && Number.isFinite(beAtR) && pr >= beAtR) {
      if (side === "BUY") newSL = Math.max(newSL, beInfo.be);
      else newSL = Math.min(newSL, beInfo.be);
    }

    // ATR trail from swing extremes (conservative) - only after trailStartR
    if (risk > 0 && pr >= trailStartR && Number.isFinite(a) && a > 0) {
      if (side === "BUY") newSL = Math.max(newSL, hi - atrMult * a);
      else newSL = Math.min(newSL, lo + atrMult * a);
    }

    // Never loosen beyond initial SL
    if (side === "BUY") newSL = Math.max(newSL, sl0);
    else newSL = Math.min(newSL, sl0);

    // Broker-valid guard: SL should not be beyond market (avoid immediate invalid trigger)
    const buffer = tick; // keep at least 1 tick away
    if (side === "BUY") newSL = clamp(newSL, undefined, ltp - buffer);
    else newSL = clamp(newSL, ltp + buffer, undefined);

    newSL = roundToTick(newSL, tick, side === "BUY" ? "down" : "up");

    const slMove = side === "BUY" ? newSL - curSL : curSL - newSL;
    const shouldMoveSL = Number.isFinite(slMove) && slMove >= step;

    // ---------- dynamic target ----------
    const mode = String(env.DYN_TARGET_MODE || "STATIC").toUpperCase(); // STATIC|FOLLOW_RR|TIGHTEN_VWAP
    const rrFollow = Number(env.DYN_TARGET_RR ?? rr);
    const tightenVwapFrac = Number(env.DYN_TARGET_TIGHTEN_FRAC ?? 0.6); // how aggressively to pull target in

    const curTarget = Number(trade.targetPrice ?? 0);
    let newTarget = curTarget > 0 ? curTarget : null;

    const allowTargetTighten =
      String(env.DYN_ALLOW_TARGET_TIGHTEN || "false") === "true" ||
      pr >= Number(env.DYN_TARGET_TIGHTEN_AFTER_R ?? 1.5);

    if (mode === "FOLLOW_RR" && allowTargetTighten) {
      // Keep RR aligned to the *current* stop (as SL trails up, target tightens too)
      const riskNow = Math.abs(entry - newSL);
      const t = computeTargetFromRisk({
        side,
        entry,
        risk: riskNow,
        rr: rrFollow,
        tick,
      });
      if (t != null) newTarget = t;
    }

    if (mode === "TIGHTEN_VWAP" && allowTargetTighten) {
      // If price comes back to VWAP, tighten target to get out quicker (only after enough profit).
      const vwap = rollingVWAP(candles, Number(env.DYN_VWAP_LOOKBACK ?? 120));
      if (Number.isFinite(vwap) && vwap > 0) {
        const dist = Math.abs(ltp - vwap);
        // If we're close to VWAP relative to initial risk, reduce target to secure profit.
        if (risk > 0 && dist <= risk) {
          if (side === "BUY") {
            const desired = ltp + tightenVwapFrac * risk;
            newTarget = roundToTick(
              Math.max(curTarget || 0, desired),
              tick,
              "up",
            );
          } else {
            const desired = ltp - tightenVwapFrac * risk;
            newTarget = roundToTick(
              Math.min(curTarget || desired, desired),
              tick,
              "down",
            );
          }
        }
      }
    }

    // Ensure target stays on profitable side of entry
    if (newTarget != null && Number.isFinite(newTarget)) {
      if (side === "BUY") newTarget = Math.max(newTarget, entry + tick);
      else newTarget = Math.min(newTarget, entry - tick);
    } else {
      newTarget = null;
    }

    const tMove =
      newTarget != null && curTarget > 0
        ? Math.abs(newTarget - curTarget)
        : newTarget != null
          ? Infinity
          : 0;

    const shouldMoveTarget =
      mode !== "STATIC" &&
      allowTargetTighten &&
      newTarget != null &&
      tMove >= step;

    basePlan = {
      ok: true,
      sl: shouldMoveSL ? { stopLoss: newSL } : null,
      target: shouldMoveTarget ? { targetPrice: newTarget } : null,
      meta: {
        at: new Date(now).toISOString(),
        side,
        ltp,
        entry,
        sl0,
        curSL,
        newSL,
        atr: a,
        hi,
        lo,
        risk,
        profitR: pr,
        rr,
        mode,
        allowTargetTighten,
        curTarget: curTarget || null,
        newTarget,
        trueBE: beInfo?.be,
        trueBEMeta: beInfo?.meta || null,
        trailStartR,
        beAtR,
      },
    };
  }

  return applyMinGreenExitRules({
    trade,
    ltp,
    underlyingLtp,
    now,
    env,
    basePlan,
    entry,
    sl0,
    side,
    tick,
    candles,
    quoteSnapshot,
  });
}

module.exports = { computeDynamicExitPlan };
