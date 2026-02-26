const { env } = require("../config");
const { getDb } = require("../db");

const COLLECTION = "risk_limits";
const DOC_ID = "active";

function defaultLimits() {
  const dailyLossCap = Number(env.DAILY_MAX_LOSS_INR ?? 0);
  const ddThrottleR = Number(env.DAILY_DD_THROTTLE_R ?? 2.0);
  const ddPauseR = Number(env.DAILY_DD_PAUSE_R ?? 3.0);
  const maxOpenTrades = Number(env.MAX_OPEN_POSITIONS ?? 1);
  const maxTradesPerDay = Number(env.MAX_TRADES_PER_DAY ?? 0);
  return {
    dailyLossCapInr: Number.isFinite(dailyLossCap) ? dailyLossCap : null,
    dailyDrawdownThrottleR: Number.isFinite(ddThrottleR) ? ddThrottleR : null,
    dailyDrawdownPauseR: Number.isFinite(ddPauseR) ? ddPauseR : null,
    maxDrawdownInr: Number(env.RISK_MAX_DRAWDOWN_INR ?? dailyLossCap * 2 ?? 0),
    maxOpenTrades: Number.isFinite(maxOpenTrades) ? maxOpenTrades : null,
    maxTradesPerDay: Number.isFinite(maxTradesPerDay)
      ? maxTradesPerDay
      : null,
    maxPerSymbolExposureInr: Number(
      env.RISK_MAX_EXPOSURE_PER_SYMBOL_INR ?? 0,
    ),
    maxPortfolioExposureInr: Number(
      env.RISK_MAX_PORTFOLIO_EXPOSURE_INR ?? 0,
    ),
    maxLeverage: Number(env.RISK_MAX_LEVERAGE ?? 0),
    maxMarginUtilization: Number(env.RISK_MAX_MARGIN_UTILIZATION ?? 0),
  };
}


function evaluateDailyRiskState({ dayPnlR, limits } = {}) {
  const pnlR = Number(dayPnlR);
  const pauseR = Number(limits?.dailyDrawdownPauseR ?? env.DAILY_DD_PAUSE_R ?? 3.0);
  const throttleR = Number(limits?.dailyDrawdownThrottleR ?? env.DAILY_DD_THROTTLE_R ?? 2.0);
  const profitLockStartR = Number(env.DAILY_PROFIT_LOCK_START_R ?? 2.0);

  if (Number.isFinite(pnlR) && Number.isFinite(pauseR) && pnlR <= -pauseR) {
    return { state: "PAUSED", reason: "DAILY_DD_PAUSE_R" };
  }
  if (Number.isFinite(pnlR) && Number.isFinite(throttleR) && pnlR <= -throttleR) {
    return { state: "THROTTLED", reason: "DAILY_DD_THROTTLE_R" };
  }
  if (Number.isFinite(pnlR) && Number.isFinite(profitLockStartR) && pnlR >= profitLockStartR) {
    return { state: "PROFIT_LOCK", reason: "DAILY_PROFIT_LOCK_START_R" };
  }
  return { state: "RUNNING", reason: null };
}

function isEntryAllowedForState(state) {
  const s = String(state || "RUNNING").toUpperCase();
  return s !== "PAUSED";
}

function riskMultiplierForState(state) {
  const s = String(state || "RUNNING").toUpperCase();
  if (s === "THROTTLED") return Number(env.DAILY_DD_THROTTLE_RISK_MULT ?? 0.6);
  if (s === "PROFIT_LOCK") return Number(env.DAILY_PROFIT_LOCK_RISK_MULT ?? 0.5);
  if (s === "PAUSED") return 0;
  return 1;
}

async function getRiskLimits() {
  let db;
  try {
    db = getDb();
  } catch {
    return { source: "default", limits: defaultLimits() };
  }

  const doc = await db.collection(COLLECTION).findOne({ _id: DOC_ID });
  if (!doc) return { source: "default", limits: defaultLimits() };
  return { source: "db", limits: { ...defaultLimits(), ...doc.limits } };
}

async function setRiskLimits(patch) {
  const db = getDb();
  const clean = { ...defaultLimits(), ...(patch || {}) };
  await db
    .collection(COLLECTION)
    .updateOne(
      { _id: DOC_ID },
      { $set: { limits: clean, updatedAt: new Date() } },
      { upsert: true },
    );
  return clean;
}

module.exports = {
  getRiskLimits,
  setRiskLimits,
  defaultLimits,
  evaluateDailyRiskState,
  isEntryAllowedForState,
  riskMultiplierForState,
};
