const https = require("https");
const { env } = require("../config");
const { logger } = require("../logger");

function isEnabled() {
  return String(env.TELEGRAM_ENABLED) === "true" && !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_CHAT_ID;
}

function postJson(hostname, path, bodyObj) {
  const body = Buffer.from(JSON.stringify(bodyObj), "utf8");
  const opts = {
    hostname,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": body.length,
    },
    timeout: 10_000,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

async function sendTelegramMessage(text) {
  if (!isEnabled()) return { skipped: true };
  const path = `/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const parseMode = String(env.TELEGRAM_PARSE_MODE || "HTML").toUpperCase();
  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
  };
  if (["HTML", "MARKDOWN", "MARKDOWNV2"].includes(parseMode)) {
    payload.parse_mode = parseMode;
  }

  try {
    const res = await postJson("api.telegram.org", path, payload);
    if (res.status >= 400) {
      logger.warn({ status: res.status, data: res.data }, "[telegram] send failed");
    }
    return res;
  } catch (e) {
    logger.warn({ e: e.message }, "[telegram] send error");
    return { error: e.message };
  }
}

module.exports = { sendTelegramMessage, isEnabled };
