const { logger } = require("../logger");
const { alert } = require("../alerts/alertService");

let halted = false;
let haltInfo = null;

async function halt(reason, meta) {
  if (halted) return;
  halted = true;
  haltInfo = { reason: String(reason || "unknown"), at: new Date().toISOString(), meta: meta || null };
  logger.error(haltInfo, "[halt] trading halted");
  // fire-and-forget
  alert("error", `🛑 TRADING HALTED: ${haltInfo.reason}`, haltInfo).catch(() => {});
}

function isHalted() {
  return halted;
}

function getHaltInfo() {
  return haltInfo;
}

function resetHalt() {
  halted = false;
  haltInfo = null;
}

module.exports = { halt, isHalted, getHaltInfo, resetHalt };
