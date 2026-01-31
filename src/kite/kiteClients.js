const KiteConnect = require("kiteconnect").KiteConnect;
const KiteTicker = require("kiteconnect").KiteTicker;
const { logger } = require("../logger");
const { halt } = require("../runtime/halt");

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function isAuthError(err) {
  const msg = String(err?.message || err || "");
  return (
    msg.includes("Incorrect `api_key` or `access_token`") ||
    msg.includes("TokenException") ||
    msg.includes("SessionExpired") ||
    (msg.includes("invalid token")) ||
    (msg.includes("access_token") && msg.includes("expired"))
  );
}

async function withRetry(fn, { name, attempts = 3, baseDelayMs = 250 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (isAuthError(e)) {
        await halt("KITE_AUTH_ERROR", { name, message: e.message });
        throw e;
      }
      if (i === attempts - 1) break;
      const wait = baseDelayMs * Math.pow(2, i);
      logger.warn({ name, attempt: i + 1, wait, e: e.message }, "[kite] call failed; retrying");
      await sleep(wait);
    }
  }
  throw lastErr;
}

function wrapKiteConnect(kc) {
  // Wrap high-value methods
  const methods = [
    // NOTE: placeOrder is intentionally NOT retried here (duplicate-order risk).
    // Use TradeManager._safePlaceOrder for controlled retries / de-dup.
    "placeOrder",
    "cancelOrder",
    "modifyOrder",
    "getOrders",
    "getOrderHistory",
    "getPositions",
    "getMargins",
    "getHoldings",
    "getInstruments",
    "getLTP",
    "getQuote",
  ];

  for (const m of methods) {
    if (typeof kc[m] !== "function") continue;
    const orig = kc[m].bind(kc);

    // placeOrder: single attempt only (no retry)
    if (m === "placeOrder") {
      kc[m] = (...args) => withRetry(() => orig(...args), { name: m, attempts: 1 });
      continue;
    }

    kc[m] = (...args) => withRetry(() => orig(...args), { name: m });
  }

  return kc;
}

function createKiteConnect({ apiKey, accessToken }) {
  const kc = new KiteConnect({ api_key: apiKey });
  kc.setAccessToken(accessToken);
  return wrapKiteConnect(kc);
}

function createTicker({ apiKey, accessToken }) {
  const t = new KiteTicker({ api_key: apiKey, access_token: accessToken });
  try {
    // enable auto-reconnect (delay=5s, retries=50)
    t.autoReconnect(true, 5, 50);
  } catch {}
  return t;
}

module.exports = { createKiteConnect, createTicker };
