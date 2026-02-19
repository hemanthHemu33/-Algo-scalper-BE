const { DateTime } = require("luxon");

function tz(env) {
  return env?.CANDLE_TZ || "Asia/Kolkata";
}

function hhmmToMinutes(hhmm) {
  const s = String(hhmm || "").trim();
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseExpiryISO(expiryISO, env) {
  const s = String(expiryISO || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return DateTime.fromISO(s, { zone: tz(env) }).startOf("day");
}

function daysToExpiry(expiryISO, env, nowMs = Date.now()) {
  const e = parseExpiryISO(expiryISO, env);
  if (!e) return null;
  const today = DateTime.fromMillis(nowMs, { zone: tz(env) }).startOf("day");
  // Calendar day difference
  return Math.round(e.diff(today, "days").days);
}

function isExpiryAllowed({ expiryISO, env, nowMs, minDaysToExpiry, avoidExpiryDayAfter }) {
  const dte = daysToExpiry(expiryISO, env, nowMs);
  if (dte == null) return { ok: false, reason: "INVALID_EXPIRY", dte: null };

  const configuredMin = Number.isFinite(Number(minDaysToExpiry))
    ? Number(minDaysToExpiry)
    : Number(env?.OPT_MIN_DAYS_TO_EXPIRY ?? 0);
  const allowZeroDte = Boolean(env?.OPT_ALLOW_ZERO_DTE ?? false);
  const minDays = allowZeroDte ? configuredMin : Math.max(1, configuredMin);

  if (Number.isFinite(minDays) && dte < minDays) {
    return { ok: false, reason: "MIN_DTE", dte };
  }

  const cutoff = hhmmToMinutes(
    avoidExpiryDayAfter ?? env?.OPT_AVOID_EXPIRY_DAY_AFTER ?? null,
  );

  if (cutoff != null && dte === 0) {
    const now = DateTime.fromMillis(nowMs || Date.now(), { zone: tz(env) });
    const m = now.hour * 60 + now.minute;
    if (m >= cutoff) {
      return { ok: false, reason: "EXPIRY_DAY_CUTOFF", dte };
    }
  }

  return { ok: true, reason: "OK", dte };
}

function pickBestExpiryISO({ expiries, env, nowMs }) {
  const list = Array.from(
    new Set((expiries || []).map((x) => String(x).slice(0, 10))),
  )
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))
    .sort();

  const allowed = [];
  for (const e of list) {
    const policy = isExpiryAllowed({ expiryISO: e, env, nowMs });
    if (policy.ok) allowed.push({ expiryISO: e, dte: Number(policy.dte), policy });
  }

  if (!allowed.length) {
    // fallback: nearest even if policy blocks
    return {
      expiryISO: list[0] || null,
      policy: {
        ok: false,
        reason: "FALLBACK",
        dte: list[0] ? daysToExpiry(list[0], env, nowMs) : null,
      },
    };
  }

  const preferMin = Number(env?.OPT_DTE_PREFER_MIN ?? 1);
  const preferMax = Number(env?.OPT_DTE_PREFER_MAX ?? 3);
  const fallbackMax = Number(env?.OPT_DTE_FALLBACK_MAX ?? 7);

  const withinPrefer = allowed.find(
    (x) => Number.isFinite(x.dte) && x.dte >= preferMin && x.dte <= preferMax,
  );
  if (withinPrefer) return { expiryISO: withinPrefer.expiryISO, policy: withinPrefer.policy };

  const withinFallback = allowed.find(
    (x) => Number.isFinite(x.dte) && x.dte <= fallbackMax,
  );
  if (withinFallback) {
    return { expiryISO: withinFallback.expiryISO, policy: withinFallback.policy };
  }

  // fallback: earliest allowed expiry (sorted by date)
  return { expiryISO: allowed[0].expiryISO, policy: allowed[0].policy };
}

module.exports = {
  hhmmToMinutes,
  daysToExpiry,
  isExpiryAllowed,
  pickBestExpiryISO,
};
