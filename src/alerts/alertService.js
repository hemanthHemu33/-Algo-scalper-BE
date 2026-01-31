const { env } = require("../config");
const { sendTelegramMessage } = require("./telegram");
const { logger } = require("../logger");

const LEVELS = { info: 10, warn: 20, error: 30 };

function minLevel() {
  const l = String(env.TELEGRAM_MIN_LEVEL || "info").toLowerCase();
  return LEVELS[l] ?? LEVELS.info;
}

function fmtMeta(meta) {
  if (!meta) return "";
  try {
    const s = JSON.stringify(meta);
    return s.length > 1200 ? s.slice(0, 1200) + "…" : s;
  } catch {
    return String(meta);
  }
}

async function alert(level, message, meta) {
  const lv = String(level || "info").toLowerCase();
  const score = LEVELS[lv] ?? LEVELS.info;
  if (score < minLevel()) return;

  const text = meta
    ? `${message}\n\n${fmtMeta(meta)}`
    : message;

  logger.info({ level: lv }, "[alert] " + message);
  await sendTelegramMessage(text);
}

module.exports = { alert };
