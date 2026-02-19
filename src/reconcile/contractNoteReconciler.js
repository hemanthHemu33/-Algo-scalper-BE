const fs = require("fs");
const path = require("path");
const { env } = require("../config");
const { logger } = require("../logger");
const { getDb } = require("../db");
const { parseCsvToObjects } = require("../utils/csv");
const { ORDER_LINKS, TRADES } = require("../trading/tradeStore");
const { estimateRoundTripCostInr } = require("../trading/costModel");
const { costCalibrator } = require("../trading/costCalibrator");

function up(s) {
  return String(s || "").trim().toUpperCase();
}

function normKey(k) {
  return String(k || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function toNum(x) {
  if (x === null || x === undefined) return NaN;
  if (typeof x === "number") return x;
  const s = String(x)
    .replace(/[,₹\s]/g, "")
    .replace(/\((.*)\)/, "-$1")
    .trim();
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

function pick(row, keys) {
  for (const k of keys) {
    if (row && Object.prototype.hasOwnProperty.call(row, k)) return row[k];
  }
  return undefined;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function rowToNormMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[normKey(k)] = v;
  }
  return out;
}

function extractOrderId(nrow) {
  const v = pick(nrow, ["order_id", "orderid", "order", "orderid_", "orderid__"]);
  const s = String(v || "").trim();
  return s || null;
}

function extractTotalChargesInr(nrow) {
  // Prefer explicit total if present.
  const total = toNum(
    pick(nrow, ["total_charges", "totalcharges", "charges", "total_charge"]) ||
      pick(nrow, ["total", "total_tax", "total_taxes"]),
  );
  if (Number.isFinite(total)) return total;

  // Otherwise sum known legs (common Zerodha Tradebook / Contract Note exports)
  const parts = [
    "brokerage",
    "stt",
    "transaction_charges",
    "exchange_transaction_charges",
    "gst",
    "sebi_charges",
    "stamp_duty",
    "ipft",
    "dp_charges",
    "other_charges",
  ];
  let sum = 0;
  let any = false;
  for (const p of parts) {
    const x = toNum(pick(nrow, [p]));
    if (Number.isFinite(x)) {
      sum += x;
      any = true;
    }
  }
  return any ? sum : NaN;
}

async function buildChargesByOrderIdFromCsvText(csvText) {
  const objects = parseCsvToObjects(csvText);
  const chargesByOrderId = new Map();
  const badRows = [];

  for (const obj of objects) {
    const nrow = rowToNormMap(obj);
    const orderId = extractOrderId(nrow);
    if (!orderId) {
      badRows.push({ reason: "missing_order_id", row: obj });
      continue;
    }

    const charges = extractTotalChargesInr(nrow);
    if (!Number.isFinite(charges)) {
      badRows.push({ reason: "missing_charges", orderId, row: obj });
      continue;
    }

    const prev = Number(chargesByOrderId.get(orderId) ?? 0);
    chargesByOrderId.set(orderId, prev + charges);
  }

  return { chargesByOrderId, badRows, rows: objects.length };
}

async function reconcileChargesFromFiles({ files = [], label = null } = {}) {
  const db = getDb();

  const allCharges = new Map();
  const fileSummaries = [];
  const badRows = [];

  for (const f of files) {
    const p = path.resolve(String(f));
    if (!fs.existsSync(p)) {
      fileSummaries.push({ file: p, ok: false, error: "not_found" });
      continue;
    }

    const txt = fs.readFileSync(p, "utf8");
    const out = await buildChargesByOrderIdFromCsvText(txt);

    for (const [orderId, ch] of out.chargesByOrderId.entries()) {
      const prev = Number(allCharges.get(orderId) ?? 0);
      allCharges.set(orderId, prev + Number(ch));
    }

    fileSummaries.push({
      file: p,
      ok: true,
      rows: out.rows,
      ordersWithCharges: out.chargesByOrderId.size,
      badRows: out.badRows.length,
    });
    badRows.push(...out.badRows);
  }

  const orderIds = Array.from(allCharges.keys());
  if (!orderIds.length) {
    return {
      ok: false,
      error: "no_orders_parsed",
      fileSummaries,
      badRowsSample: badRows.slice(0, 5),
    };
  }

  // Join with order_links -> tradeId
  const links = [];
  for (const part of chunk(orderIds, 500)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await db
      .collection(ORDER_LINKS)
      .find({ order_id: { $in: part } })
      .toArray();
    links.push(...(rows || []));
  }

  const tradeCharges = new Map(); // tradeId -> { actualChargesInr, orderIds: [] }
  const missingLinks = [];

  const linkedOrderSet = new Set();
  for (const l of links) {
    const oid = String(l.order_id || "");
    linkedOrderSet.add(oid);
    const tid = String(l.tradeId || "");
    if (!tid) continue;
    const ch = Number(allCharges.get(oid) ?? 0);
    const prev = tradeCharges.get(tid) || { actualChargesInr: 0, orderIds: [] };
    prev.actualChargesInr += ch;
    prev.orderIds.push(oid);
    tradeCharges.set(tid, prev);
  }
  for (const oid of orderIds) {
    if (!linkedOrderSet.has(oid)) missingLinks.push(oid);
  }

  // Load trades
  const tradeIds = Array.from(tradeCharges.keys());
  const trades = [];
  for (const part of chunk(tradeIds, 300)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await db
      .collection(TRADES)
      .find({ tradeId: { $in: part } })
      .toArray();
    trades.push(...(rows || []));
  }

  const tradeById = new Map(trades.map((t) => [String(t.tradeId), t]));

  // Build per-trade comparisons
  const comparisons = [];
  const perSegAgg = {}; // seg -> { actualSum, baseSum, trades }

  for (const [tradeId, agg] of tradeCharges.entries()) {
    const t = tradeById.get(String(tradeId));
    if (!t) continue;

    const actual = Number(agg.actualChargesInr ?? 0);
    if (!Number.isFinite(actual) || actual < 0) continue;

    const entry = Number(t.entryPrice ?? 0);
    const qty = Number(t.initialQty ?? 0);
    const spreadBps = Number(t.spreadBpsUsed ?? 0);
    const execOrders = Number(t.feeMultipleExecOrders ?? env.EXPECTED_EXECUTED_ORDERS ?? 2);

    if (!(entry > 0) || !(qty > 0)) continue;

    const base = estimateRoundTripCostInr({
      entryPrice: entry,
      qty,
      spreadBps,
      instrument: t.instrument || null,
      env: { ...env, EXPECTED_EXECUTED_ORDERS: execOrders, COST_CALIBRATION_ENABLED: "false" },
      disableCalibration: true,
    });
    const baseEst = Number(base?.estCostInr ?? 0);
    if (!(baseEst > 0)) continue;

    const segKey = up(base?.meta?.segmentKey || "UNKNOWN");
    const ratio = actual / baseEst;

    comparisons.push({
      tradeId,
      segKey,
      actualChargesInr: actual,
      baseEstimatedInr: baseEst,
      ratio,
      orderIds: agg.orderIds,
    });

    if (!perSegAgg[segKey]) perSegAgg[segKey] = { actualSum: 0, baseSum: 0, trades: 0 };
    perSegAgg[segKey].actualSum += actual;
    perSegAgg[segKey].baseSum += baseEst;
    perSegAgg[segKey].trades += 1;
  }

  const ratiosBySegment = {};
  for (const [seg, a] of Object.entries(perSegAgg)) {
    if (a.baseSum > 0) ratiosBySegment[seg] = a.actualSum / a.baseSum;
  }

  const runMeta = {
    label: label || null,
    files: files || [],
    parsedOrders: orderIds.length,
    linkedOrders: orderIds.length - missingLinks.length,
    missingLinks: missingLinks.length,
    comparedTrades: comparisons.length,
    perSegAgg,
    ts: Date.now(),
  };

  logger.info(
    {
      label,
      files: files.length,
      parsedOrders: orderIds.length,
      comparedTrades: comparisons.length,
      ratiosBySegment,
    },
    "[costReconcile] computed ratios",
  );

  const updateRes = await costCalibrator.updateFromRatios({ ratiosBySegment, runMeta });

  return {
    ok: true,
    runMeta,
    updateRes,
    ratiosBySegment,
    fileSummaries,
    badRowsSample: badRows.slice(0, 10),
    missingLinksSample: missingLinks.slice(0, 25),
    comparisonsSample: comparisons
      .slice()
      .sort((a, b) => (b.actualChargesInr || 0) - (a.actualChargesInr || 0))
      .slice(0, 25),
  };
}

module.exports = {
  reconcileChargesFromFiles,
};
