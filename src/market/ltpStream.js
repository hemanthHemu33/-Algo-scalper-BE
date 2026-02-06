const { EventEmitter } = require("events");

const ltpStream = new EventEmitter();
ltpStream.setMaxListeners(100);

const lastByToken = new Map();

function buildPayload(token, tick) {
  const ltp = Number(tick?.last_price);
  if (!Number.isFinite(ltp)) return null;

  const exchangeTimestamp = tick?.exchange_timestamp
    ? new Date(tick.exchange_timestamp)
    : null;
  const lastTradeTime = tick?.last_trade_time
    ? new Date(tick.last_trade_time)
    : null;
  const updatedAt = exchangeTimestamp || lastTradeTime || new Date();

  return {
    token,
    ltp,
    exchangeTimestamp,
    lastTradeTime,
    updatedAt,
  };
}

function updateFromTicks(ticks = []) {
  for (const tick of ticks || []) {
    const token = Number(tick?.instrument_token);
    if (!Number.isFinite(token) || token <= 0) continue;
    const payload = buildPayload(token, tick);
    if (!payload) continue;
    lastByToken.set(token, payload);
    ltpStream.emit("tick", payload);
  }
}

function getLatestLtp(token) {
  const t = Number(token);
  if (!Number.isFinite(t) || t <= 0) return null;
  return lastByToken.get(t) || null;
}

function getLatestLtps(tokens = []) {
  const out = [];
  for (const token of tokens || []) {
    const t = Number(token);
    if (!Number.isFinite(t) || t <= 0) continue;
    const row = lastByToken.get(t);
    if (row) out.push(row);
  }
  return out;
}

module.exports = {
  ltpStream,
  updateFromTicks,
  getLatestLtp,
  getLatestLtps,
};
