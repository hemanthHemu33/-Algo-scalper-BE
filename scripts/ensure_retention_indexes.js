/**
 * PATCH-9 — Ensure candle TTL (retention) indexes
 *
 * Usage:
 *   node scripts/ensure_retention_indexes.js
 *
 * Notes:
 * - Requires MONGO_URI/MONGO_DB in env (same as engine).
 * - TTL will DELETE old candle docs beyond the retention window.
 */
const { connectMongo } = require("../src/db");
const { ensureRetentionIndexes, describeRetention } = require("../src/market/retention");
const { logger } = require("../src/logger");

async function main() {
  await connectMongo();

  const out = await ensureRetentionIndexes({ log: true });
  const after = await describeRetention();

  // Print a concise console summary
  const cols = (after.collections || []).map((c) => ({
    intervalMin: c.intervalMin,
    collection: c.collection,
    desiredDays: c.desiredDays,
    currentExpireAfterSeconds: c.currentTtlIndex?.expireAfterSeconds ?? null,
  }));

  logger.info({ result: out, collections: cols }, "[retention] ensure complete");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, result: out, collections: cols }, null, 2));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("ensure_retention_indexes failed:", e?.message || e);
  process.exit(1);
});
