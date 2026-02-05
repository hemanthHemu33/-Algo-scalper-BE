const { env } = require("../config");

let override = null;

function getTradingEnabled() {
  if (override === null) {
    return String(env.TRADING_ENABLED) === "true";
  }
  return !!override;
}

function getTradingEnabledSource() {
  return override === null ? "env" : "runtime";
}

function setTradingEnabled(enabled) {
  override = enabled === null || typeof enabled === "undefined" ? null : !!enabled;
  return {
    enabled: getTradingEnabled(),
    source: getTradingEnabledSource(),
  };
}

module.exports = {
  getTradingEnabled,
  getTradingEnabledSource,
  setTradingEnabled,
};
