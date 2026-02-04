const { getDb } = require("../db");

const TRADES = "trades";
const ORDER_LINKS = "order_links";
const DAILY_RISK = "daily_risk";
const RISK_STATE = "risk_state";
const ORPHAN_ORDER_UPDATES = "orphan_order_updates";
const ORDER_LOGS = "order_logs";
// Patch-6: cost calibration & reconciliations (post-trade cost model tuning)
const COST_CALIBRATION = "cost_calibration";
const COST_RECONCILIATIONS = "cost_reconciliations";

async function ensureTradeIndexes() {
  const db = getDb();
  await db.collection(TRADES).createIndex({ tradeId: 1 }, { unique: true });
  await db.collection(TRADES).createIndex({ status: 1, updatedAt: -1 });
  await db
    .collection(ORDER_LINKS)
    .createIndex({ order_id: 1 }, { unique: true });
  await db.collection(ORDER_LINKS).createIndex({ tradeId: 1 });
  await db.collection(DAILY_RISK).createIndex({ date: 1 }, { unique: true });
  await db.collection(ORDER_LOGS).createIndex({ order_id: 1, createdAt: -1 });
  await db.collection(ORDER_LOGS).createIndex({ tradeId: 1, createdAt: -1 });
  await db.collection(RISK_STATE).createIndex({ date: 1 }, { unique: true });

  // Cost calibration (one doc per segmentKey)
  await db
    .collection(COST_CALIBRATION)
    .createIndex({ segmentKey: 1 }, { unique: true });
  await db.collection(COST_RECONCILIATIONS).createIndex({ createdAt: -1 });

  // Orphan order updates: store early postbacks that arrive before order_id->tradeId link exists.
  // TTL 6 hours (21600 sec)
  await db
    .collection(ORPHAN_ORDER_UPDATES)
    .createIndex({ createdAt: 1 }, { expireAfterSeconds: 6 * 60 * 60 });
  await db
    .collection(ORPHAN_ORDER_UPDATES)
    .createIndex({ order_id: 1, createdAt: 1 });
}

async function insertTrade(trade) {
  const db = getDb();
  await db
    .collection(TRADES)
    .insertOne({ ...trade, createdAt: new Date(), updatedAt: new Date() });
}

async function updateTrade(tradeId, patch) {
  const db = getDb();
  await db
    .collection(TRADES)
    .updateOne({ tradeId }, { $set: { ...patch, updatedAt: new Date() } });
}

async function getTrade(tradeId) {
  const db = getDb();
  return db.collection(TRADES).findOne({ tradeId });
}

async function getActiveTrades() {
  const db = getDb();
  return db
    .collection(TRADES)
    .find({
      status: {
        $in: [
          "ENTRY_PLACED",
          "ENTRY_OPEN",
          "ENTRY_FILLED",
          "LIVE",
          "GUARD_FAILED",
        ],
      },
    })
    .toArray();
}

async function linkOrder({ order_id, tradeId, role }) {
  const db = getDb();
  await db.collection(ORDER_LINKS).updateOne(
    { order_id },
    {
      $set: { order_id, tradeId, role, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
}

async function findTradeByOrder(order_id) {
  const db = getDb();
  const link = await db.collection(ORDER_LINKS).findOne({ order_id });
  if (!link) return null;
  const trade = await db.collection(TRADES).findOne({ tradeId: link.tradeId });
  return trade ? { trade, link } : null;
}

async function saveOrphanOrderUpdate({ order_id, payload }) {
  const db = getDb();
  if (!order_id) return;
  await db.collection(ORPHAN_ORDER_UPDATES).insertOne({
    order_id: String(order_id),
    payload,
    createdAt: new Date(),
  });
}

async function popOrphanOrderUpdates(order_id) {
  const db = getDb();
  const oid = String(order_id || "");
  if (!oid) return [];
  const rows = await db
    .collection(ORPHAN_ORDER_UPDATES)
    .find({ order_id: oid })
    .sort({ createdAt: 1 })
    .toArray();

  if (rows.length) {
    await db.collection(ORPHAN_ORDER_UPDATES).deleteMany({ order_id: oid });
  }

  return rows.map((r) => r.payload).filter(Boolean);
}

async function appendOrderLog({ order_id, tradeId, status, payload }) {
  const db = getDb();
  const oid = String(order_id || "");
  if (!oid) return;
  await db.collection(ORDER_LOGS).insertOne({
    order_id: oid,
    tradeId: tradeId || null,
    status: status || null,
    payload: payload || null,
    createdAt: new Date(),
  });
}

async function getOrderLogs({ order_id, tradeId, limit = 200 }) {
  const db = getDb();
  const query = {};
  if (order_id) query.order_id = String(order_id);
  if (tradeId) query.tradeId = tradeId;
  return db
    .collection(ORDER_LOGS)
    .find(query)
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(limit, 500)))
    .toArray();
}

async function upsertDailyRisk(date, patch) {
  const db = getDb();
  await db.collection(DAILY_RISK).updateOne(
    { date },
    {
      $set: { ...patch, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date(), date },
    },
    { upsert: true },
  );
}

async function getDailyRisk(date) {
  const db = getDb();
  return db.collection(DAILY_RISK).findOne({ date });
}

async function upsertRiskState(date, patch) {
  const db = getDb();
  await db.collection(RISK_STATE).updateOne(
    { date },
    {
      $set: { ...patch, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date(), date },
    },
    { upsert: true },
  );
}

async function getRiskState(date) {
  const db = getDb();
  return db.collection(RISK_STATE).findOne({ date });
}

module.exports = {
  TRADES,
  ORDER_LINKS,
  DAILY_RISK,
  RISK_STATE,
  ORPHAN_ORDER_UPDATES,
  ORDER_LOGS,
  COST_CALIBRATION,
  COST_RECONCILIATIONS,
  ensureTradeIndexes,
  insertTrade,
  updateTrade,
  getTrade,
  getActiveTrades,
  linkOrder,
  findTradeByOrder,
  saveOrphanOrderUpdate,
  popOrphanOrderUpdates,
  appendOrderLog,
  getOrderLogs,
  upsertDailyRisk,
  getDailyRisk,
  upsertRiskState,
  getRiskState,
};
