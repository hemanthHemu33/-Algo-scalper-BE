const { DateTime } = require("luxon");

/**
 * Dynamic pacing policy to aim for a target trades/day (5-7 default -> 6).
 * Adjusts selectivity (confidence/spread/relVol) softly.
 * Does NOT touch hard risk rails.
 */

function clamp(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function tz(env) {
  return env.CANDLE_TZ || "Asia/Kolkata";
}

function minutesOfDay(now = Date.now(), env) {
  const dt = DateTime.fromMillis(Number(now) || Date.now(), { zone: tz(env) });
  return dt.hour * 60 + dt.minute;
}

function hhmmToMinutes(hhmm) {
  const s = String(hhmm || "").trim();
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function safeNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function summarizeRejections(snapshot) {
  const blockedByReason = snapshot?.blockedByReason || {};
  let lowConf = 0;
  let spread = 0;
  let relVol = 0;

  for (const [k, v] of Object.entries(blockedByReason)) {
    const key = String(k || "").toUpperCase();
    const n = safeNum(v, 0);
    if (key.includes("CONF")) lowConf += n;
    if (key.includes("SPREAD")) spread += n;
    if (key.includes("REL_VOLUME") || key.includes("REL VOLUME")) relVol += n;
  }

  return { lowConf, spread, relVol };
}

function computePacingPolicy({ env, tradesToday, telemetrySnapshot, nowMs }) {
  const enabled = String(env.PACE_POLICY_ENABLED || "false") === "true";
  const target = safeNum(env.PACE_TARGET_TRADES_PER_DAY, 6);
  const t = safeNum(tradesToday, 0);

  if (!enabled) {
    return {
      enabled: false,
      minConf: safeNum(env.MIN_SIGNAL_CONFIDENCE, 0),
      maxSpreadBps: safeNum(env.MAX_SPREAD_BPS, 16),
      maxSpreadBpsOpt: safeNum(env.OPT_MAX_SPREAD_BPS, 25),
      minRelVolBase: safeNum(env.MIN_REL_VOLUME, 0.6),
      meta: { reason: "disabled" },
    };
  }

  const openMin = hhmmToMinutes(env.MARKET_OPEN || "09:15") ?? 9 * 60 + 15;
  const stopNewMin =
    hhmmToMinutes(env.STOP_NEW_ENTRIES_AFTER || "15:00") ?? 15 * 60;

  const m = minutesOfDay(nowMs || Date.now(), env);
  const denom = Math.max(30, stopNewMin - openMin);
  const progress = clamp((m - openMin) / denom, 0, 1);
  const expectedByNow = target * progress;
  const pressure = t - expectedByNow;

  const confFloor = safeNum(env.PACE_MIN_CONF_FLOOR, 62);
  const confCeil = safeNum(env.PACE_MAX_CONF_CEIL, 85);
  const confStep = safeNum(env.PACE_CONF_STEP, 3);

  const spreadFloor = safeNum(env.PACE_MIN_SPREAD_FLOOR_BPS, 14);
  const spreadCeil = safeNum(env.PACE_MAX_SPREAD_CEIL_BPS, 22);
  const spreadStep = safeNum(env.PACE_SPREAD_STEP_BPS, 2);

  const relFloor = safeNum(env.PACE_MIN_REL_VOL_FLOOR, 0.45);
  const relCeil = safeNum(env.PACE_MAX_REL_VOL_CEIL, 1.2);
  const relStep = safeNum(env.PACE_REL_VOL_STEP, 0.05);

  let minConf = clamp(
    safeNum(env.MIN_SIGNAL_CONFIDENCE, confFloor),
    confFloor,
    confCeil,
  );
  let maxSpreadBps = clamp(
    safeNum(env.MAX_SPREAD_BPS, spreadCeil),
    spreadFloor,
    spreadCeil,
  );
  let maxSpreadBpsOpt = clamp(
    safeNum(env.OPT_MAX_SPREAD_BPS, maxSpreadBps + 6),
    spreadFloor + 4,
    spreadCeil + 20,
  );
  let minRelVolBase = clamp(
    safeNum(env.MIN_REL_VOLUME, relFloor),
    relFloor,
    relCeil,
  );

  const rej = summarizeRejections(telemetrySnapshot);

  // Under-trading: relax the biggest blocker
  if (pressure < -1) {
    if (rej.lowConf >= rej.spread && rej.lowConf >= rej.relVol) {
      minConf -= confStep;
    } else if (rej.spread >= rej.relVol) {
      maxSpreadBps += spreadStep;
      maxSpreadBpsOpt += spreadStep;
    } else {
      minRelVolBase -= relStep;
    }
  }

  // Over-trading: tighten a bit
  if (pressure > 1) {
    minConf += confStep;
    maxSpreadBps -= spreadStep;
    maxSpreadBpsOpt -= spreadStep;
    minRelVolBase += relStep;
  }

  // Late-session tighten
  const closeStart =
    hhmmToMinutes(
      env.OPT_BUCKET_CLOSE_START || env.STOP_NEW_ENTRIES_AFTER || "15:00",
    ) ?? 15 * 60;
  if (m >= closeStart) {
    minConf += confStep;
    maxSpreadBps -= spreadStep;
    maxSpreadBpsOpt -= spreadStep;
  }

  minConf = clamp(minConf, confFloor, confCeil);
  maxSpreadBps = clamp(maxSpreadBps, spreadFloor, spreadCeil);
  maxSpreadBpsOpt = clamp(maxSpreadBpsOpt, spreadFloor + 4, spreadCeil + 20);
  minRelVolBase = clamp(minRelVolBase, relFloor, relCeil);

  return {
    enabled: true,
    minConf,
    maxSpreadBps,
    maxSpreadBpsOpt,
    minRelVolBase,
    meta: {
      target,
      tradesToday: t,
      progress,
      expectedByNow,
      pressure,
      rejections: rej,
    },
  };
}

module.exports = { computePacingPolicy };
