const { getDb } = require("../db");

const STATUSES = [
  "ENTRY_PLACED",
  "ENTRY_OPEN",
  "ENTRY_REPLACED",
  "ENTRY_CANCELLED",
  "ENTRY_FILLED",
  "LIVE",
  "CLOSED",
  "EXITED_TARGET",
  "EXITED_SL",
  "ENTRY_FAILED",
  "GUARD_FAILED",
];

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function getExecutionQuality({ limit = 500 } = {}) {
  const db = getDb();
  const rows = await db
    .collection("trades")
    .find({ status: { $in: STATUSES } })
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(limit, 2000)))
    .toArray();

  const entrySlipBps = [];
  const exitSlipInr = [];
  let entryPlaced = 0;
  let entryFilled = 0;

  const rejections = {};

  for (const t of rows) {
    if (
      t.status === "ENTRY_PLACED" ||
      t.status === "ENTRY_OPEN" ||
      t.status === "ENTRY_REPLACED"
    ) {
      entryPlaced += 1;
    }
    if (
      ["ENTRY_FILLED", "LIVE", "CLOSED", "EXITED_TARGET", "EXITED_SL"].includes(
        t.status,
      )
    ) {
      entryFilled += 1;
    }

    if (["ENTRY_FAILED", "ENTRY_CANCELLED", "GUARD_FAILED"].includes(t.status)) {
      const reason = String(t.closeReason || t.status || "UNKNOWN");
      rejections[reason] = (rejections[reason] || 0) + 1;
    }

    const expected = safeNumber(t.expectedEntryPrice);
    const actual = safeNumber(t.entryPrice);
    if (expected && actual) {
      const slip = ((actual - expected) / expected) * 10000;
      entrySlipBps.push(slip);
    }

    const slipDelta = safeNumber(t.pnlSlippageDeltaInr);
    if (slipDelta !== null) exitSlipInr.push(slipDelta);
  }

  return {
    sampleSize: rows.length,
    slippage: {
      avgEntrySlippageBps: mean(entrySlipBps),
      avgExitSlippageInr: mean(exitSlipInr),
    },
    fillRate: entryPlaced > 0 ? entryFilled / entryPlaced : null,
    latency: {
      orderPlacementMs: null,
      orderFillMs: null,
      exitFillMs: null,
    },
    rejections,
  };
}

module.exports = { getExecutionQuality };
