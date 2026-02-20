const { env } = require("../config");
const { sendTelegramMessage } = require("./telegram");
const { logger } = require("../logger");
const os = require("os");

const LEVELS = { info: 10, warn: 20, error: 30 };
const LEVEL_BADGES = {
  info: "🟢 INFO",
  warn: "🟠 WARN",
  error: "🔴 ERROR",
};

function minLevel() {
  const l = String(env.TELEGRAM_MIN_LEVEL || "info").toLowerCase();
  return LEVELS[l] ?? LEVELS.info;
}

function fmtMeta(meta) {
  if (!meta) return "";
  try {
    const s = JSON.stringify(meta);
    const maxChars = Number(env.TELEGRAM_MAX_META_CHARS || 1500);
    return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
  } catch {
    return String(meta);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildDetailedMessage(level, message, meta) {
  const now = new Date().toISOString();
  const badge = LEVEL_BADGES[level] || LEVEL_BADGES.info;
  const base = [
    `<b>${badge}</b>`,
    `<b>Event:</b> ${escapeHtml(message)}`,
    `<b>Time:</b> ${now}`,
    `<b>Host:</b> ${escapeHtml(os.hostname())}`,
  ];
  const m = fmtMeta(meta);
  if (m) base.push(`<b>Meta</b>\n<pre>${escapeHtml(m)}</pre>`);
  return base.join("\n");
}

async function alert(level, message, meta) {
  const lv = String(level || "info").toLowerCase();
  const score = LEVELS[lv] ?? LEVELS.info;
  if (score < minLevel()) return;

  const detailed = String(env.TELEGRAM_DETAILED || "true") === "true";
  const text = detailed
    ? buildDetailedMessage(lv, message, meta)
    : meta
      ? `${message}\n\n${fmtMeta(meta)}`
      : message;

  logger.info({ level: lv }, "[alert] " + message);
  await sendTelegramMessage(text);
}

module.exports = { alert };
