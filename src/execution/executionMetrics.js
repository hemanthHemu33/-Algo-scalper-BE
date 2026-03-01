const { getDb } = require("../db");

const COLLECTION = "execution_state";

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function safeDateKey(dateKey) {
  const key = String(dateKey || "").trim();
  return key || new Date().toISOString().slice(0, 10);
}

function safeSymbol(symbol) {
  return String(symbol || "ALL").trim().toUpperCase() || "ALL";
}

function computeRates(doc) {
  const entryCount = n(doc?.entryCount, 0);
  const exitCount = n(doc?.exitCount, 0);
  const spreadSamples = n(doc?.spreadSamples, 0);
  const spreadRejects = n(doc?.spreadRejectCount, 0);
  const modifyAttempts = n(doc?.orderModifyAttempts, 0);
  const modifyFails = n(doc?.orderModifyFailures, 0);

  return {
    avgEntrySlipPts: entryCount > 0 ? n(doc?.entrySlipPtsSum, 0) / entryCount : 0,
    avgExitSlipPts: exitCount > 0 ? n(doc?.exitSlipPtsSum, 0) / exitCount : 0,
    avgSpreadBpsAtEntry: spreadSamples > 0 ? n(doc?.spreadBpsSumAtEntry, 0) / spreadSamples : 0,
    rejectRateDueToSpread: (entryCount + spreadRejects) > 0 ? spreadRejects / (entryCount + spreadRejects) : 0,
    orderModifyFailRate: modifyAttempts > 0 ? modifyFails / modifyAttempts : 0,
  };
}

async function ensureExecutionMetricsIndexes() {
  const db = getDb();
  await db.collection(COLLECTION).createIndex({ date: 1, symbol: 1 }, { unique: true });
  await db.collection(COLLECTION).createIndex({ updatedAt: -1 });
}

async function upsertAndRecompute({ dateKey, symbol, inc = {}, set = {}, push = {} }) {
  const db = getDb();
  const date = safeDateKey(dateKey);
  const sym = safeSymbol(symbol);
  const now = new Date();

  const update = {
    $setOnInsert: { date, symbol: sym, createdAt: now },
    $set: { ...set, updatedAt: now },
  };
  if (Object.keys(inc).length) update.$inc = inc;
  if (Object.keys(push).length) update.$push = push;

  const result = await db.collection(COLLECTION).findOneAndUpdate(
    { date, symbol: sym },
    update,
    { upsert: true, returnDocument: "after" },
  );

  const computed = computeRates(result || {});
  await db.collection(COLLECTION).updateOne(
    { date, symbol: sym },
    { $set: { ...computed, updatedAt: now } },
  );
  return { ...(result || {}), ...computed };
}

async function recordEntryFill({ dateKey, symbol, slipPts = 0, spreadBpsAtEntry = null }) {
  return upsertAndRecompute({
    dateKey,
    symbol,
    inc: {
      entryCount: 1,
      entrySlipPtsSum: n(slipPts, 0),
      spreadSamples: Number.isFinite(Number(spreadBpsAtEntry)) ? 1 : 0,
      spreadBpsSumAtEntry: Number.isFinite(Number(spreadBpsAtEntry)) ? Number(spreadBpsAtEntry) : 0,
    },
    push: {
      recentEntrySlipPts: {
        $each: [n(slipPts, 0)],
        $slice: -100,
      },
    },
  });
}

async function recordExitFill({ dateKey, symbol, slipPts = 0 }) {
  return upsertAndRecompute({
    dateKey,
    symbol,
    inc: {
      exitCount: 1,
      exitSlipPtsSum: n(slipPts, 0),
    },
  });
}

async function recordSpreadReject({ dateKey, symbol }) {
  return upsertAndRecompute({ dateKey, symbol, inc: { spreadRejectCount: 1 } });
}

async function recordOrderModifyResult({ dateKey, symbol, success }) {
  return upsertAndRecompute({
    dateKey,
    symbol,
    inc: {
      orderModifyAttempts: 1,
      orderModifyFailures: success ? 0 : 1,
    },
    push: success
      ? {}
      : {
          recentModifyFailsTs: {
            $each: [Date.now()],
            $slice: -100,
          },
        },
  });
}

async function getExecutionMetrics({ dateKey, symbol }) {
  const db = getDb();
  const row = await db.collection(COLLECTION).findOne({ date: safeDateKey(dateKey), symbol: safeSymbol(symbol) });
  if (!row) return null;
  return { ...row, ...computeRates(row) };
}

function evaluateExecutionBreaker({ metrics, env }) {
  const enabled = String(env?.EXECUTION_BREAKER_ENABLED ?? "true") === "true";
  if (!enabled) return { tripped: false, reason: "DISABLED" };
  const windowTrades = Math.max(1, n(env?.EXEC_BREAKER_WINDOW_TRADES, 5));
  const maxAvgSlip = Math.max(0, n(env?.EXEC_BREAKER_AVG_SLIP_PTS_MAX, 2));
  const recent = Array.isArray(metrics?.recentEntrySlipPts) ? metrics.recentEntrySlipPts.slice(-windowTrades) : [];
  const avgSlip = recent.length ? recent.reduce((a, b) => a + Math.abs(n(b, 0)), 0) / recent.length : 0;
  if (recent.length >= windowTrades && avgSlip > maxAvgSlip) {
    return { tripped: true, reason: "AVG_SLIPPAGE", avgSlip, windowTrades };
  }
  const failRate = n(metrics?.orderModifyFailRate, 0);
  if (failRate >= 1 && n(metrics?.orderModifyAttempts, 0) >= windowTrades) {
    return { tripped: true, reason: "MODIFY_FAIL_BURST", failRate };
  }
  return { tripped: false, reason: "OK", avgSlip };
}

module.exports = {
  ensureExecutionMetricsIndexes,
  recordEntryFill,
  recordExitFill,
  recordSpreadReject,
  recordOrderModifyResult,
  getExecutionMetrics,
  evaluateExecutionBreaker,
};
