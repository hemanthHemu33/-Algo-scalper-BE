function toAllowedStrategies(raw) {
  return String(raw || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function evaluateReentryOverride({
  env,
  nowMs,
  tz,
  blockedReason,
  signal,
  riskKey,
  stopout,
  timeToFlattenSec,
  spreadBps,
  expectedSlippagePts,
}) {
  const out = {
    allow: false,
    riskMult: 1.0,
    canTradeCtx: null,
    reason: "reentry_disabled",
    meta: {
      riskKey,
      blockedReason,
      tz,
    },
  };

  if (!["cooldown", "after_entry_cutoff", "no_trade_window"].includes(String(blockedReason || ""))) {
    out.reason = "blocked_reason_not_eligible";
    return out;
  }

  const confidence = Number(signal?.confidence);
  const strategyId = String(signal?.strategyId || "").trim().toLowerCase();

  if (
    blockedReason === "after_entry_cutoff" &&
    env?.LATE_ENTRY_FRESH_OVERRIDE_ENABLED &&
    (!stopout || !Number.isFinite(Number(stopout.ts)))
  ) {
    const freshMinConf = Number(env.LATE_ENTRY_FRESH_MIN_CONF ?? 93);
    if (!Number.isFinite(confidence) || confidence < freshMinConf) {
      out.reason = "fresh_late_entry_confidence_below_min";
      out.meta.confidence = confidence;
      out.meta.freshMinConf = freshMinConf;
      return out;
    }

    const freshMaxSpreadBps = Number(env.LATE_ENTRY_FRESH_MAX_SPREAD_BPS ?? 18);
    const spread = Number(spreadBps);
    if (!Number.isFinite(spread) || spread > freshMaxSpreadBps) {
      out.reason = "fresh_late_entry_spread_too_wide";
      out.meta.spreadBps = spread;
      out.meta.freshMaxSpreadBps = freshMaxSpreadBps;
      return out;
    }

    const freshMaxSlippagePts = Number(
      env.LATE_ENTRY_FRESH_MAX_EXPECTED_SLIPPAGE_PTS ?? env.EXPECTED_SLIPPAGE_POINTS ?? 0,
    );
    const slippagePts = Number(expectedSlippagePts);
    if (!Number.isFinite(slippagePts) || slippagePts > freshMaxSlippagePts) {
      out.reason = "fresh_late_entry_slippage_too_high";
      out.meta.expectedSlippagePts = slippagePts;
      out.meta.freshMaxSlippagePts = freshMaxSlippagePts;
      return out;
    }

    const minTimeToFlattenSec = Number(env.LATE_ENTRY_MIN_TIME_TO_FLATTEN_SEC ?? 600);
    if (!Number.isFinite(Number(timeToFlattenSec)) || Number(timeToFlattenSec) < minTimeToFlattenSec) {
      out.reason = "late_entry_time_to_flatten_too_low";
      out.meta.timeToFlattenSec = Number(timeToFlattenSec);
      out.meta.minTimeToFlattenSec = minTimeToFlattenSec;
      return out;
    }

    const allowUntil = String(env.LATE_ENTRY_ALLOW_UNTIL || "").trim();
    if (!allowUntil) {
      out.reason = "late_entry_allow_until_missing";
      return out;
    }

    out.allow = true;
    out.canTradeCtx = {
      ignoreCooldown: true,
      allowAfterEntryCutoffUntil: allowUntil,
    };
    out.riskMult = Number(env.LATE_ENTRY_FRESH_R_MULT ?? 0.3);
    out.reason = "fresh_late_entry_allowed";
    out.meta = {
      ...out.meta,
      confidence,
      strategyId,
      spreadBps: spread,
      expectedSlippagePts: slippagePts,
      timeToFlattenSec: Number(timeToFlattenSec),
    };
    return out;
  }

  if (!env?.REENTRY_AFTER_SL_ENABLED) {
    out.reason = "reentry_disabled";
    return out;
  }

  if (!stopout || !Number.isFinite(Number(stopout.ts))) {
    out.reason = "no_recent_stopout";
    return out;
  }

  const windowSec = Number(env.REENTRY_AFTER_SL_WINDOW_SEC ?? 180);
  const ageMs = Number(nowMs) - Number(stopout.ts);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > windowSec * 1000) {
    out.reason = "stopout_window_expired";
    out.meta.ageMs = ageMs;
    out.meta.windowSec = windowSec;
    return out;
  }

  const maxTries = Number(env.REENTRY_AFTER_SL_MAX_TRIES ?? 1);
  const attempts = Number(stopout.attempts ?? 0);
  if (attempts >= maxTries) {
    out.reason = "max_reentry_attempts_reached";
    out.meta.attempts = attempts;
    out.meta.maxTries = maxTries;
    return out;
  }

  const minConf = Number(env.REENTRY_AFTER_SL_MIN_CONF ?? 85);
  if (!Number.isFinite(confidence) || confidence < minConf) {
    out.reason = "confidence_below_reentry_min";
    out.meta.confidence = confidence;
    out.meta.minConf = minConf;
    return out;
  }

  const allowedStrategies = toAllowedStrategies(env.REENTRY_AFTER_SL_ALLOWED_STRATEGIES);
  if (!allowedStrategies.includes(strategyId)) {
    out.reason = "strategy_not_allowed";
    out.meta.strategyId = strategyId;
    out.meta.allowedStrategies = allowedStrategies;
    return out;
  }

  const canTradeCtx = { ignoreCooldown: true };

  if (blockedReason === "no_trade_window" && !env.REENTRY_AFTER_SL_ALLOW_DURING_NO_TRADE_WINDOWS) {
    out.reason = "no_trade_window_override_disabled";
    return out;
  }

  if (blockedReason === "after_entry_cutoff") {
    if (!env.LATE_ENTRY_OVERRIDE_ENABLED) {
      out.reason = "late_entry_override_disabled";
      return out;
    }

    const lateMinConf = Number(
      env.REENTRY_AFTER_SL_LATE_MIN_CONF ?? env.LATE_ENTRY_MIN_CONF ?? 85,
    );
    if (!Number.isFinite(confidence) || confidence < lateMinConf) {
      out.reason = "late_entry_confidence_below_min";
      out.meta.confidence = confidence;
      out.meta.lateMinConf = lateMinConf;
      return out;
    }

    const minTimeToFlattenSec = Number(env.LATE_ENTRY_MIN_TIME_TO_FLATTEN_SEC ?? 600);
    if (!Number.isFinite(Number(timeToFlattenSec)) || Number(timeToFlattenSec) < minTimeToFlattenSec) {
      out.reason = "late_entry_time_to_flatten_too_low";
      out.meta.timeToFlattenSec = Number(timeToFlattenSec);
      out.meta.minTimeToFlattenSec = minTimeToFlattenSec;
      return out;
    }

    const allowUntil = String(env.LATE_ENTRY_ALLOW_UNTIL || "").trim();
    if (!allowUntil) {
      out.reason = "late_entry_allow_until_missing";
      return out;
    }
    canTradeCtx.allowAfterEntryCutoffUntil = allowUntil;
  }

  out.allow = true;
  out.canTradeCtx = canTradeCtx;
  out.riskMult = Number(env.REENTRY_AFTER_SL_R_MULT ?? 0.5);
  out.reason = "reentry_allowed";
  out.meta = {
    ...out.meta,
    confidence,
    strategyId,
    attempts,
    maxTries,
    ageMs,
  };

  return out;
}

module.exports = { evaluateReentryOverride };
