const { getDb } = require("../db");
const { logger } = require("../logger");
const { canTransition, normalizeTradeStatus } = require("./tradeStateMachine");

const TRADES = "trades";
const ORDER_LINKS = "order_links";
const DAILY_RISK = "daily_risk";
const RISK_STATE = "risk_state";
const ORPHAN_ORDER_UPDATES = "orphan_order_updates";
const ORPHAN_ORDER_UPDATES_DLQ = "orphan_order_updates_dlq";
const ORDER_LOGS = "order_logs";
const LIVE_ORDER_SNAPSHOTS = "live_order_snapshots";
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
  await db
    .collection(LIVE_ORDER_SNAPSHOTS)
    .createIndex({ tradeId: 1 }, { unique: true });
  await db.collection(LIVE_ORDER_SNAPSHOTS).createIndex({ updatedAt: -1 });
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
  await db
    .collection(ORPHAN_ORDER_UPDATES_DLQ)
    .createIndex({ order_id: 1, deadLetteredAt: -1 });
  await db
    .collection(ORPHAN_ORDER_UPDATES_DLQ)
    .createIndex({ deadLetteredAt: 1 });
}

async function insertTrade(trade) {
  const db = getDb();
  await db
    .collection(TRADES)
    .insertOne({ ...trade, createdAt: new Date(), updatedAt: new Date() });
}

async function updateTrade(tradeId, patch) {
  const db = getDb();
  const update = { ...(patch || {}) };

  if (Object.prototype.hasOwnProperty.call(update, "status")) {
    try {
      const current = await db.collection(TRADES).findOne({ tradeId });
      const fromStatus = current?.status || null;
      const toStatus = normalizeTradeStatus(update.status);

      // Broker order postbacks can arrive out of order.
      // Ignore late ENTRY_FILLED updates once a trade already has SL/LIVE state.
      const staleEntryFill =
        toStatus === "ENTRY_FILLED" &&
        ["SL_PLACED", "SL_OPEN", "SL_CONFIRMED", "LIVE"].includes(
          normalizeTradeStatus(fromStatus),
        );
      if (staleEntryFill) {
        logger.info(
          { tradeId, fromStatus, toStatus },
          "[trade] stale ENTRY_FILLED transition ignored",
        );
        delete update.status;
      }

      const validation = canTransition(fromStatus, toStatus);

      if (!staleEntryFill && !validation.ok) {
        logger.error(
          { tradeId, fromStatus, toStatus, reason: validation.reason },
          "[trade] invalid status transition blocked",
        );
        delete update.status;
        update.statusTransitionError = {
          from: fromStatus,
          to: toStatus,
          reason: validation.reason,
          ts: new Date(),
        };
      } else if (!staleEntryFill) {
        update.status = toStatus;
      }
    } catch (e) {
      logger.warn(
        { tradeId, e: e?.message || String(e) },
        "[trade] status transition validation skipped",
      );
    }
  }

  await db
    .collection(TRADES)
    .updateOne({ tradeId }, { $set: { ...update, updatedAt: new Date() } });
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
          "ENTRY_REPLACED",
          "ENTRY_FILLED",
          "SL_PLACED",
          "SL_CONFIRMED",
          "LIVE",
          "EXIT_PLACED",
          "EXIT_OPEN",
          "EXIT_PARTIAL",
          "PANIC_EXIT_PLACED",
          "RECOVERY_REHYDRATED",
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

async function deadLetterOrphanOrderUpdates({ order_id, reason, meta }) {
  const db = getDb();
  const oid = String(order_id || "");
  if (!oid) return { moved: 0 };

  const rows = await db
    .collection(ORPHAN_ORDER_UPDATES)
    .find({ order_id: oid })
    .sort({ createdAt: 1 })
    .toArray();

  if (!rows.length) return { moved: 0 };

  await db.collection(ORPHAN_ORDER_UPDATES_DLQ).insertMany(
    rows.map((row) => ({
      order_id: oid,
      payload: row.payload || null,
      orphanCreatedAt: row.createdAt || new Date(),
      deadLetteredAt: new Date(),
      reason: reason || "MAX_RETRIES_EXHAUSTED",
      meta: meta || null,
    })),
  );

  await db.collection(ORPHAN_ORDER_UPDATES).deleteMany({ order_id: oid });
  return { moved: rows.length };
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

async function upsertLiveOrderSnapshot({ tradeId, orderId, role, order, source }) {
  const db = getDb();
  const tid = String(tradeId || "");
  const oid = String(orderId || "");
  if (!tid || !oid) return;

  const now = new Date();
  const roleKey = String(role || "UNKNOWN")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
  const status = String(order?.status || "").toUpperCase() || null;
  const snapshotEntry = {
    orderId: oid,
    role: roleKey,
    status,
    source: source || null,
    seenAt: now,
    order: order || null,
  };

  const setPatch = {
    tradeId: tid,
    updatedAt: now,
    [`byOrderId.${oid}`]: snapshotEntry,
  };
  if (roleKey) setPatch[`byRole.${roleKey}`] = snapshotEntry;

  await db.collection(LIVE_ORDER_SNAPSHOTS).updateOne(
    { tradeId: tid },
    {
      $set: setPatch,
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

async function getLiveOrderSnapshotsByTradeIds(tradeIds = []) {
  const db = getDb();
  const ids = (tradeIds || []).map((x) => String(x || "")).filter(Boolean);
  if (!ids.length) return [];
  return db
    .collection(LIVE_ORDER_SNAPSHOTS)
    .find({ tradeId: { $in: ids } })
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
  LIVE_ORDER_SNAPSHOTS,
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
  deadLetterOrphanOrderUpdates,
  appendOrderLog,
  getOrderLogs,
  upsertLiveOrderSnapshot,
  getLiveOrderSnapshotsByTradeIds,
  upsertDailyRisk,
  getDailyRisk,
  upsertRiskState,
  getRiskState,
};
