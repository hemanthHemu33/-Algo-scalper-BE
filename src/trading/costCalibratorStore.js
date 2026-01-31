const { env } = require("../config");
const { getDb } = require("../db");
const { COST_CALIBRATION, COST_RECONCILIATIONS } = require("./tradeStore");

function enabled() {
  return String(env.COST_CALIBRATION_ENABLED || "false") === "true";
}

async function readAllCalibration() {
  const db = getDb();
  const rows = await db
    .collection(COST_CALIBRATION)
    .find({})
    .sort({ segmentKey: 1 })
    .toArray();
  return rows || [];
}

async function upsertCalibration({ segmentKey, multiplier, meta }) {
  const db = getDb();
  const sk = String(segmentKey || "").toUpperCase();
  if (!sk) throw new Error("segmentKey required");

  const m = Number(multiplier);
  if (!Number.isFinite(m) || m <= 0) throw new Error("invalid multiplier");

  await db.collection(COST_CALIBRATION).updateOne(
    { segmentKey: sk },
    {
      $set: {
        segmentKey: sk,
        multiplier: m,
        meta: meta || null,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
      $inc: { updates: 1 },
    },
    { upsert: true },
  );
}

async function insertReconciliationRun(doc) {
  const db = getDb();
  await db.collection(COST_RECONCILIATIONS).insertOne({
    ...doc,
    createdAt: new Date(),
  });
}

async function listReconciliations(limit = 10) {
  const db = getDb();
  const n = Math.min(50, Math.max(1, Number(limit) || 10));
  return db
    .collection(COST_RECONCILIATIONS)
    .find({})
    .sort({ createdAt: -1 })
    .limit(n)
    .toArray();
}

module.exports = {
  enabled,
  readAllCalibration,
  upsertCalibration,
  insertReconciliationRun,
  listReconciliations,
};
