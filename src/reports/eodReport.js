const { getDb } = require("../db");
const { DateTime } = require("luxon");
const { env } = require("../config");
const { normalizeTradeRow } = require("../trading/tradeNormalization");

const TRADES = "trades";

function parseDayBounds(day) {
  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  const parsed =
    typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)
      ? DateTime.fromISO(day, { zone: tz })
      : null;

  const base = parsed?.isValid ? parsed : DateTime.now().setZone(tz);
  const start = base.startOf("day");
  const end = start.plus({ days: 1 });
  return {
    day: start.toFormat("yyyy-LL-dd"),
    start: start.toJSDate(),
    end: end.toJSDate(),
  };
}

function pnlForTrade(t) {
  const gross = Number(t?.pnlGrossInr);
  if (Number.isFinite(gross)) return gross;

  const entry = Number(t?.entryPrice ?? 0);
  const exit = Number(t?.exitPrice ?? 0);
  const qty = Number(t?.qty ?? 0);
  const side = String(t?.side || "BUY").toUpperCase();
  if (!(entry > 0) || !(exit > 0) || !(qty > 0)) return null;
  return side === "BUY" ? (exit - entry) * qty : (entry - exit) * qty;
}

function clusterKey(t) {
  return `${String(t?.strategyId || "UNKNOWN")}::${String(t?.closeReason || "NA")}`;
}

function anomalyTags(trade, pnl) {
  const tags = [];
  const latencyMs =
    trade?.decisionAt && trade?.entryAt
      ? new Date(trade.entryAt).getTime() - new Date(trade.decisionAt).getTime()
      : null;

  if (!trade?.decisionAt || !trade?.entryAt || !trade?.exitAt) {
    tags.push("MISSING_LATENCY_TIMESTAMPS");
  }
  if (Number.isFinite(latencyMs) && latencyMs > 30_000) {
    tags.push("ENTRY_LATENCY_HIGH");
  }

  const entrySlip = Number(trade?.costPayload?.entrySlippage ?? 0);
  const exitSlip = Number(trade?.costPayload?.exitSlippage ?? 0);
  if (entrySlip > 0 || exitSlip > 0) {
    const slippageTotal = entrySlip + exitSlip;
    const feeBase = Math.abs(Number(trade?.pnlGrossInr ?? pnl ?? 0));
    if (slippageTotal >= 250 || (feeBase > 0 && slippageTotal / feeBase > 0.4)) {
      tags.push("SLIPPAGE_SPIKE");
    }
  }

  const fees = Number(trade?.costPayload?.feesTotal ?? trade?.estCostsInr ?? 0);
  if (Number.isFinite(fees)) {
    const pnlAbs = Math.abs(Number(pnl ?? 0));
    if (fees > 0 && pnlAbs > 0 && fees / pnlAbs >= 0.75) {
      tags.push("FEES_DOMINANT");
    }
    if (fees >= 500) tags.push("HIGH_ABSOLUTE_FEES");
  }

  return tags;
}

async function buildEodReport({ day } = {}) {
  const db = getDb();
  const { start, end, day: resolvedDay } = parseDayBounds(day);

  const rows = await db
    .collection(TRADES)
    .find({
      $or: [
        { closedAt: { $gte: start, $lt: end } },
        { updatedAt: { $gte: start, $lt: end } },
      ],
      status: {
        $in: ["EXITED_TARGET", "EXITED_SL", "CLOSED", "ENTRY_FAILED", "ENTRY_CANCELLED"],
      },
    })
    .project({
      tradeId: 1,
      strategyId: 1,
      status: 1,
      side: 1,
      qty: 1,
      entryPrice: 1,
      exitPrice: 1,
      closeReason: 1,
      pnlGrossInr: 1,
      estCostsInr: 1,
      costPayload: 1,
      decisionAt: 1,
      entryAt: 1,
      exitAt: 1,
      marketContextAtEntry: 1,
      createdAt: 1,
      updatedAt: 1,
      closedAt: 1,
    })
    .sort({ closedAt: 1, updatedAt: 1 })
    .toArray();

  const trades = rows.map((row) => normalizeTradeRow(row));

  const clusters = new Map();
  const anomalyMap = new Map();
  let wins = 0;
  let losses = 0;
  let neutral = 0;

  for (const t of trades) {
    const pnl = pnlForTrade(t);
    if (Number.isFinite(pnl)) {
      if (pnl > 0) wins += 1;
      else if (pnl < 0) losses += 1;
      else neutral += 1;
    } else {
      neutral += 1;
    }

    const k = clusterKey(t);
    const prev =
      clusters.get(k) ||
      ({
        strategyId: t?.strategyId || "UNKNOWN",
        closeReason: t?.closeReason || "NA",
        outcome: Number(pnl) > 0 ? "WIN" : Number(pnl) < 0 ? "LOSS" : "FLAT",
        count: 0,
        totalPnlInr: 0,
      });
    prev.count += 1;
    prev.totalPnlInr += Number.isFinite(pnl) ? pnl : 0;
    clusters.set(k, prev);

    const tags = anomalyTags(t, pnl);
    for (const tag of tags) {
      const bucket = anomalyMap.get(tag) || { tag, count: 0, tradeIds: [] };
      bucket.count += 1;
      if (bucket.tradeIds.length < 50) bucket.tradeIds.push(t.tradeId);
      anomalyMap.set(tag, bucket);
    }
  }

  return {
    ok: true,
    day: resolvedDay,
    window: { start, end },
    totals: {
      trades: trades.length,
      wins,
      losses,
      neutral,
      winRate: trades.length ? wins / trades.length : 0,
    },
    winLossClusters: Array.from(clusters.values()).sort(
      (a, b) => b.count - a.count,
    ),
    anomalyTags: Array.from(anomalyMap.values()).sort(
      (a, b) => b.count - a.count,
    ),
  };
}

module.exports = { buildEodReport };
