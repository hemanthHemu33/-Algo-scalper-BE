const { DateTime } = require("luxon");
const { alert } = require("../alerts/alertService");

const DEDUPE_MS = 10 * 60 * 1000;
const lastByEvent = new Map();

function toIstNow() {
  return DateTime.now().setZone("Asia/Kolkata").toFormat("yyyy-LL-dd HH:mm:ss ZZZZ");
}

function pickLevel(event) {
  if (event === "TOKEN_MISSING") return "warn";
  if (event === "FORCE_FLATTEN_RESULT") return "warn";
  return "info";
}

function shouldSkip(event) {
  const now = Date.now();
  const last = Number(lastByEvent.get(String(event)) || 0);
  if (now - last < DEDUPE_MS) return true;
  lastByEvent.set(String(event), now);
  return false;
}

async function notifyLifecycle(event, payload = {}) {
  try {
    const e = String(event || "UNKNOWN").trim().toUpperCase();
    if (!e) return { ok: false, skipped: true, reason: "missing_event" };
    if (shouldSkip(e)) return { ok: true, skipped: true, reason: "dedupe" };

    const meta = {
      event: e,
      istAt: toIstNow(),
      ...payload,
    };
    await alert(pickLevel(e), `[lifecycle] ${e}`, meta);
    return { ok: true, skipped: false };
  } catch {
    return { ok: false, skipped: true, reason: "notify_failed" };
  }
}

module.exports = { notifyLifecycle };
