const { env } = require("../config");
const { logger } = require("../logger");
const { getDb } = require("../db");

function enabled() {
  return String(env.OPT_STATE_PERSIST || "false") === "true";
}

function colName() {
  return env.OPT_STATE_COLLECTION || "optimizer_state";
}

function stateId() {
  return env.OPT_STATE_ID || "active";
}

function now() {
  return new Date();
}

async function readState() {
  if (!enabled()) return null;
  let db;
  try {
    db = getDb();
  } catch {
    return null;
  }
  try {
    const col = db.collection(colName());
    return await col.findOne({ _id: stateId() });
  } catch (e) {
    logger.warn({ e: e?.message || String(e) }, "[optimizerState] read failed");
    return null;
  }
}

async function writeState(doc) {
  if (!enabled()) return { ok: false, reason: "disabled" };
  let db;
  try {
    db = getDb();
  } catch {
    return { ok: false, reason: "db_not_ready" };
  }

  const payload = {
    ...(doc || {}),
    _id: stateId(),
    updatedAt: now(),
  };

  try {
    const col = db.collection(colName());
    await col.updateOne(
      { _id: payload._id },
      { $set: payload, $setOnInsert: { createdAt: now() } },
      { upsert: true },
    );
    return { ok: true, id: payload._id };
  } catch (e) {
    logger.warn(
      { e: e?.message || String(e) },
      "[optimizerState] write failed",
    );
    return { ok: false, reason: "write_failed", error: e?.message };
  }
}

module.exports = { enabled, readState, writeState };
