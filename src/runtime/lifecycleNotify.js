const { DateTime } = require("luxon");
const { alert } = require("../alerts/alertService");

const DEDUPE_MS = 10 * 60 * 1000;
const lastByEvent = new Map();
const DEDUPE_EVENTS = new Set([
  "TOKEN_MISSING",
  "TOKEN_RESTORED",
  "TOKEN_REFRESHED",
  "WARMUP_START_FAILED",
  "LIVE_START_FAILED",
  "COOLDOWN_SESSION_START_FAILED",
  "FLAT_CHECK_ERROR_HOLDING",
]);

function toIstNow() {
  return DateTime.now().setZone("Asia/Kolkata").toFormat("yyyy-LL-dd HH:mm:ss ZZZZ");
}

function pickLevel(event, payload = {}) {
  if (event === "TOKEN_MISSING") return "warn";
  if (["WARMUP_START_FAILED", "LIVE_START_FAILED", "COOLDOWN_SESSION_START_FAILED", "FLAT_CHECK_ERROR_HOLDING"].includes(event)) return "warn";
  if (event === "FORCE_FLATTEN_RESULT") return payload?.ok ? "info" : "warn";
  return "info";
}

function shouldSkip(event, payload = {}) {
  if (!DEDUPE_EVENTS.has(String(event))) return false;
  const now = Date.now();
  const key = `${String(event)}:${String(payload?.reason || "default")}`;
  const last = Number(lastByEvent.get(key) || 0);
  if (now - last < DEDUPE_MS) return true;
  lastByEvent.set(key, now);
  return false;
}

async function notifyLifecycle(event, payload = {}) {
  try {
    const e = String(event || "UNKNOWN").trim().toUpperCase();
    if (!e) return { ok: false, skipped: true, reason: "missing_event" };
    if (shouldSkip(e, payload)) return { ok: true, skipped: true, reason: "dedupe" };

    const meta = {
      event: e,
      istAt: toIstNow(),
      ...payload,
    };
    await alert(pickLevel(e, payload), `[lifecycle] ${e}`, meta);
    return { ok: true, skipped: false };
  } catch {
    return { ok: false, skipped: true, reason: "notify_failed" };
  }
}

module.exports = { notifyLifecycle };
