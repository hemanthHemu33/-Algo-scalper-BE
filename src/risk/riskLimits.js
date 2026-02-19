const { env } = require("../config");
const { getDb } = require("../db");

const COLLECTION = "risk_limits";
const DOC_ID = "active";

function defaultLimits() {
  const dailyLossCap = Number(env.DAILY_MAX_LOSS_INR ?? 0);
  const maxOpenTrades = Number(env.MAX_OPEN_POSITIONS ?? 1);
  return {
    dailyLossCapInr: Number.isFinite(dailyLossCap) ? dailyLossCap : null,
    maxDrawdownInr: Number(env.RISK_MAX_DRAWDOWN_INR ?? dailyLossCap * 2 ?? 0),
    maxOpenTrades: Number.isFinite(maxOpenTrades) ? maxOpenTrades : null,
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

async function getRiskLimits() {
  let db;
  try {
    db = getDb();
  } catch {
    return { source: "default", limits: defaultLimits() };
  }

  const doc = await db.collection(COLLECTION).findOne({ _id: DOC_ID });
  if (!doc) return { source: "default", limits: defaultLimits() };
  const merged = { ...defaultLimits(), ...doc.limits };
  delete merged.maxTradesPerDay;
  return { source: "db", limits: merged };
}

async function setRiskLimits(patch) {
  const db = getDb();
  const clean = { ...defaultLimits(), ...(patch || {}) };
  delete clean.maxTradesPerDay;
  await db
    .collection(COLLECTION)
    .updateOne(
      { _id: DOC_ID },
      { $set: { limits: clean, updatedAt: new Date() } },
      { upsert: true },
    );
  return clean;
}

module.exports = { getRiskLimits, setRiskLimits, defaultLimits };
