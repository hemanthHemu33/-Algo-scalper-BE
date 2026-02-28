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

  if (!env?.REENTRY_AFTER_SL_ENABLED) {
    out.reason = "reentry_disabled";
    return out;
  }

  if (!["cooldown", "after_entry_cutoff"].includes(String(blockedReason || ""))) {
    out.reason = "blocked_reason_not_eligible";
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

  const confidence = Number(signal?.confidence);
  const minConf = Number(env.REENTRY_AFTER_SL_MIN_CONF ?? 85);
  if (!Number.isFinite(confidence) || confidence < minConf) {
    out.reason = "confidence_below_reentry_min";
    out.meta.confidence = confidence;
    out.meta.minConf = minConf;
    return out;
  }

  const allowedStrategies = toAllowedStrategies(env.REENTRY_AFTER_SL_ALLOWED_STRATEGIES);
  const strategyId = String(signal?.strategyId || "").trim().toLowerCase();
  if (!allowedStrategies.includes(strategyId)) {
    out.reason = "strategy_not_allowed";
    out.meta.strategyId = strategyId;
    out.meta.allowedStrategies = allowedStrategies;
    return out;
  }

  const canTradeCtx = { ignoreCooldown: true };

  if (blockedReason === "after_entry_cutoff") {
    if (!env.LATE_ENTRY_OVERRIDE_ENABLED) {
      out.reason = "late_entry_override_disabled";
      return out;
    }

    const lateMinConf = Number(env.LATE_ENTRY_MIN_CONF ?? 85);
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
