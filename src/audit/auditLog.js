const { getDb } = require("../db");

const COLLECTION = "audit_logs";

async function recordAudit({ actor, action, resource, meta, status } = {}) {
  let db;
  try {
    db = getDb();
  } catch {
    return null;
  }

  const doc = {
    actor: actor || null,
    action: action || "UNKNOWN",
    resource: resource || null,
    status: status || "ok",
    meta: meta || null,
    createdAt: new Date(),
  };

  await db.collection(COLLECTION).insertOne(doc);
  return doc;
}

async function listAuditLogs({ limit = 100 } = {}) {
  const db = getDb();
  const rows = await db
    .collection(COLLECTION)
    .find({})
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(limit, 500)))
    .toArray();
  return rows;
}

module.exports = { recordAudit, listAuditLogs };
