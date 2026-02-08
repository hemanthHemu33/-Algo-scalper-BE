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

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return n;
  if (Number.isFinite(lo)) n = Math.max(lo, n);
  if (Number.isFinite(hi)) n = Math.min(hi, n);
  return n;
}

function safeNum(v, fb = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
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
  if (sym.endsWith("CE") || sym.endsWith("PE")) return true;

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
  if (sym.endsWith("CE")) return "CE";
  if (sym.endsWith("PE")) return "PE";

  return null;
}

function computeBaseRisk(trade) {
  const entry = Number(trade.entryPrice || trade.candle?.close);
  const sl0 = Number(trade.initialStopLoss || trade.stopLoss);
  const risk = Math.abs(entry - sl0);
  return { entry, sl0, risk: Number.isFinite(risk) ? risk : 0 };
}

function profitR({ side, entry, ltp, risk }) {
  if (!Number.isFinite(entry) || !Number.isFinite(ltp) || !(risk > 0)) return 0;
  return side === "BUY" ? (ltp - entry) / risk : (entry - ltp) / risk;
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
  const qty = Number(trade.qty || trade.initialQty || 0);
  const mult = Number(env.DYN_BE_COST_MULT || 1.0);
  const bufTicks = Number(env.DYN_BE_BUFFER_TICKS || 1);
  const buffer = bufTicks * tick;

  // Fallback: just buffer ticks beyond entry
  if (!Number.isFinite(entry) || entry <= 0 || !(qty > 0)) {
    const raw = side === "BUY" ? entry + buffer : entry - buffer;
    return {
      be: roundToTick(raw, tick, side === "BUY" ? "up" : "down"),
      meta: { qty, buffer, mult, note: "no_qty_or_entry" },
    };
  }

  const { estCostInr, meta } = estimateRoundTripCostInr({
    entryPrice: entry,
    qty,
    spreadBps: 0,
    env,
    instrument: trade?.instrument || null,
  });

  const costPerShare =
    Number.isFinite(estCostInr) && estCostInr > 0 ? estCostInr / qty : 0;

  const raw =
    side === "BUY"
      ? entry + mult * costPerShare + buffer
      : entry - (mult * costPerShare + buffer);

  const be = roundToTick(raw, tick, side === "BUY" ? "up" : "down");
  return {
    be,
    meta: {
      qty,
      estCostInr,
      costPerShare,
      mult,
      buffer,
      costMeta: meta || null,
    },
  };
}

function applyMinGreenExitRules({
  trade,
  ltp,
  now,
  env,
  basePlan,
  entry,
  sl0,
  side,
  tick,
}) {
  const qty = Number(trade?.qty || trade?.initialQty || 0);
  const minGreenEnabled = String(env.MIN_GREEN_ENABLED || "true") === "true";
  const minGreenInr = minGreenEnabled ? Number(trade?.minGreenInr || 0) : 0;
  const minGreenPts = minGreenEnabled ? Number(trade?.minGreenPts || 0) : 0;

  const curSL = Number(trade?.stopLoss || sl0);
  let newSL =
    basePlan?.sl?.stopLoss && Number.isFinite(basePlan.sl.stopLoss)
      ? Number(basePlan.sl.stopLoss)
      : curSL;

  const tradePatch = { ...(basePlan?.tradePatch || {}) };

  const pnlInr = unrealizedPnlInr({ side, entry, ltp, qty });

  const timeStopMin = Number(env.TIME_STOP_MIN || 0);
  const entryTs =
    tsFrom(trade?.entryFilledAt) ||
    tsFrom(trade?.createdAt || trade?.updatedAt) ||
    now;
  const timeStopAtMs =
    Number.isFinite(timeStopMin) && timeStopMin > 0
      ? entryTs + timeStopMin * 60 * 1000
      : null;

  if (
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
        timeStopTriggeredAt: new Date(now),
      },
      meta: {
        ...(basePlan?.meta || {}),
        timeStopAtMs,
        pnlInr,
        minGreenInr,
      },
    };
  }

  const beLockAt = Number(env.BE_LOCK_AT_PROFIT_INR || 0);
  if (
    Number.isFinite(beLockAt) &&
    beLockAt > 0 &&
    pnlInr >= beLockAt &&
    minGreenPts > 0
  ) {
    const desired = side === "BUY" ? entry + minGreenPts : entry - minGreenPts;
    if (side === "BUY") newSL = Math.max(newSL, desired);
    else newSL = Math.min(newSL, desired);
    if (!trade?.beLocked) {
      tradePatch.beLocked = true;
      tradePatch.beLockedAt = new Date(now);
      tradePatch.beLockedAtPrice = desired;
    }
  }

  const trailGap = Number(env.TRAIL_GAP_PREMIUM_POINTS || 0);
  const trailAfterBe =
    String(env.DYN_TRAIL_START_AFTER_BE_LOCK || "true") === "true";
  const trailStartInr = Number(env.DYN_TRAIL_START_PROFIT_INR || 0);

  // If BE lock activates in *this* evaluation, it lives in tradePatch (trade.beLocked may still be false).
  const beLockedNow = Boolean(tradePatch.beLocked || trade?.beLocked);

  const allowTrail =
    (trailAfterBe ? beLockedNow : false) ||
    (Number.isFinite(trailStartInr) && trailStartInr > 0
      ? pnlInr >= trailStartInr
      : false) ||
    trade?.tp1Done;

  if (
    allowTrail &&
    Number.isFinite(trailGap) &&
    trailGap > 0 &&
    Number.isFinite(ltp)
  ) {
    const prevPeak = Number(trade?.peakLtp || NaN);
    let peakLtp = prevPeak;
    if (side === "BUY") {
      peakLtp = Number.isFinite(prevPeak) ? Math.max(prevPeak, ltp) : ltp;
    } else {
      peakLtp = Number.isFinite(prevPeak) ? Math.min(prevPeak, ltp) : ltp;
    }
    const trailSl = side === "BUY" ? peakLtp - trailGap : peakLtp + trailGap;
    if (!Number.isFinite(prevPeak) || peakLtp !== prevPeak) {
      tradePatch.peakLtp = peakLtp;
    }
    if (
      !Number.isFinite(Number(trade?.trailSl)) ||
      trailSl !== trade?.trailSl
    ) {
      tradePatch.trailSl = trailSl;
    }

    const threshold = 2 * tick;
    if (side === "BUY") {
      if (trailSl > newSL + threshold) newSL = trailSl;
    } else if (trailSl < newSL - threshold) {
      newSL = trailSl;
    }
  }

  // Never loosen beyond initial SL
  if (Number.isFinite(sl0)) {
    if (side === "BUY") newSL = Math.max(newSL, sl0);
    else newSL = Math.min(newSL, sl0);
  }

  // Broker-valid guard: SL should not be beyond market
  const buffer = tick;
  if (Number.isFinite(ltp)) {
    if (side === "BUY") newSL = clamp(newSL, undefined, ltp - buffer);
    else newSL = clamp(newSL, ltp + buffer, undefined);
  }

  newSL = roundToTick(newSL, tick, side === "BUY" ? "down" : "up");

  const stepTicks = Number(env.DYN_TRAIL_STEP_TICKS || 20);
  const step = stepTicks * tick;
  const slMove = side === "BUY" ? newSL - curSL : curSL - newSL;
  const shouldMoveSL = Number.isFinite(slMove) && slMove >= step;

  return {
    ...basePlan,
    ok: true,
    sl: shouldMoveSL ? { stopLoss: newSL } : basePlan?.sl || null,
    tradePatch,
    meta: {
      ...(basePlan?.meta || {}),
      pnlInr,
      minGreenInr,
      minGreenPts,
      beLockAt,
      trailGap,
      trailAfterBe,
      trailStartInr: Number.isFinite(trailStartInr) ? trailStartInr : null,
      allowTrail,
    },
  };
}

function premiumVolPct(candles, lookback = 20) {
  if (!Array.isArray(candles) || candles.length < 4) return null;
  const n = Math.max(4, Math.min(Number(lookback || 20), 120));
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
  const uNow = safeNum(underlyingLtp);
  const uEntry = safeNum(
    trade?.underlying_ltp || trade?.option_meta?.underlyingLtp,
  );
  if (!Number.isFinite(uNow) || !Number.isFinite(uEntry) || uEntry <= 0)
    return null;
  return ((uNow - uEntry) / uEntry) * 10000;
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
  const tick = Number(trade.instrument?.tick_size || 0.05);

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

  const now = Number(nowTs || Date.now());
  const refTs =
    tsFrom(trade.entryFilledAt) ||
    tsFrom(trade.createdAt) ||
    tsFrom(trade.updatedAt) ||
    now;
  const holdMin = Math.max(0, (now - refTs) / (60 * 1000));

  // ===== Time-based exit (hard stop) =====
  const maxHold = Number(env.OPT_EXIT_MAX_HOLD_MIN || 25);
  if (Number.isFinite(maxHold) && maxHold > 0 && holdMin >= maxHold) {
    return {
      ok: true,
      action: { exitNow: true, reason: `OPT_TIME_EXIT (>=${maxHold}m)` },
      meta: { holdMin, maxHold },
    };
  }

  // ===== Coarse "IV crush" protection =====
  // If premium is falling sharply while underlying hasn't moved much, it's often IV crush / theta bleed.
  const neutralBps = Number(env.OPT_IV_NEUTRAL_BPS || 12);
  const crushPct = Number(env.OPT_IV_CRUSH_PREMIUM_PCT || 18);
  const crushMinHold = Number(env.OPT_IV_CRUSH_MIN_HOLD_MIN || 3);

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
  const baseSlPct = Number(env.OPT_EXIT_BASE_SL_PCT || 18);
  const baseTpPct = Number(env.OPT_EXIT_BASE_TARGET_PCT || 35);
  const minSlPct = Number(env.OPT_EXIT_MIN_SL_PCT || 8);
  const maxSlPct = Number(env.OPT_EXIT_MAX_SL_PCT || env.OPT_MAX_SL_PCT || 35);

  const volLookback = Number(env.OPT_EXIT_VOL_LOOKBACK || 20);
  const volRef = Number(env.OPT_EXIT_VOL_REF_PCT || 6);
  const vfMin = Number(env.OPT_EXIT_WIDEN_FACTOR_MIN || 0.75);
  const vfMax = Number(env.OPT_EXIT_WIDEN_FACTOR_MAX || 1.8);

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
    holdMin <= Number(env.OPT_EXIT_WIDEN_WINDOW_MIN || 2);

  if (allowWiden && Number.isFinite(curSL)) {
    // If current SL is much tighter than the model, widen it to reduce early noise stop-outs.
    // NOTE: This is the only case where we allow loosening (options-only, early window, capped).
    if (side === "BUY" && curSL > modelSL) newSL = modelSL;
    if (side === "SELL" && curSL < modelSL) newSL = modelSL;
  }

  // ===== Premium trailing (after profit threshold) =====
  const trailStartPct = Number(env.OPT_EXIT_TRAIL_START_PROFIT_PCT || 15);
  const baseTrailPct = Number(env.OPT_EXIT_TRAIL_PCT_BASE || 12);
  const trailMin = Number(env.OPT_EXIT_TRAIL_PCT_MIN || 6);
  const trailMax = Number(env.OPT_EXIT_TRAIL_PCT_MAX || 22);

  const trailPct = clamp(baseTrailPct * volFactor, trailMin, trailMax);

  if (Number.isFinite(trailStartPct) && pPct >= trailStartPct) {
    if (side === "BUY") {
      const trailSL = roundToTick(ltp * (1 - trailPct / 100), tick, "down");
      newSL = Math.max(newSL, trailSL);
    } else {
      const trailSL = roundToTick(ltp * (1 + trailPct / 100), tick, "up");
      newSL = Math.min(newSL, trailSL);
    }
  }

  // ===== IV spike heuristic: premium up a lot while underlying "neutral" =====
  // Lock profits aggressively: tighten SL and optionally place a marketable target to hit bid/ask.
  const spikePct = Number(env.OPT_IV_SPIKE_PREMIUM_PCT || 25);
  if (
    Number.isFinite(absUBps) &&
    absUBps <= neutralBps &&
    Number.isFinite(spikePct) &&
    pPct >= spikePct
  ) {
    const spikeTrailPct = Number(env.OPT_IV_SPIKE_TRAIL_PCT || 10);
    if (side === "BUY") {
      const lockSL = roundToTick(ltp * (1 - spikeTrailPct / 100), tick, "down");
      newSL = Math.max(newSL, lockSL);

      if (String(env.OPT_IV_SPIKE_TP_TO_BID || "true") === "true") {
        const bidTicks = Number(env.OPT_IV_SPIKE_TP_BID_TICKS || 1);
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
        const bidTicks = Number(env.OPT_IV_SPIKE_TP_BID_TICKS || 1);
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
  const stepTicks = Number(env.DYN_TRAIL_STEP_TICKS || 20);
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
  underlyingLtp = null,
}) {
  const side = String(trade?.side || "").toUpperCase();
  const tick = Number(trade?.instrument?.tick_size || 0.05);

  const { entry, sl0, risk } = computeBaseRisk(trade);
  const rr = Number(trade?.rr || env.RR_TARGET || 1.0);

  // Required
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(ltp) ||
    ltp <= 0
  )
    return { ok: false, reason: "missing_prices" };

  const now = Number(nowTs || Date.now());
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
    const atrPeriod = Number(env.DYN_ATR_PERIOD || 14);
    const a = atr(candles, atrPeriod);
    const atrMult = Number(env.DYN_TRAIL_ATR_MULT || 1.2);

    // Start ATR trailing only after X R in profit
    const trailStartR = Number(env.DYN_TRAIL_START_R || 1.0);

    // Move SL to "true breakeven" after Y R in profit
    const beAtR = Number(env.DYN_MOVE_SL_TO_BE_AT_R || 0.8);

    const stepTicks = Number(env.DYN_TRAIL_STEP_TICKS || 20); // minimum move before modifying
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
    const curSL = Number(trade.stopLoss || sl0);
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
    const rrFollow = Number(env.DYN_TARGET_RR || rr);
    const tightenVwapFrac = Number(env.DYN_TARGET_TIGHTEN_FRAC || 0.6); // how aggressively to pull target in

    const curTarget = Number(trade.targetPrice || 0);
    let newTarget = curTarget > 0 ? curTarget : null;

    const allowTargetTighten =
      String(env.DYN_ALLOW_TARGET_TIGHTEN || "false") === "true" ||
      pr >= Number(env.DYN_TARGET_TIGHTEN_AFTER_R || 1.5);

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
      const vwap = rollingVWAP(candles, Number(env.DYN_VWAP_LOOKBACK || 120));
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
    now,
    env,
    basePlan,
    entry,
    sl0,
    side,
    tick,
  });
}

module.exports = { computeDynamicExitPlan };
