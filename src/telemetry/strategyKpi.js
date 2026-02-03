const { getDb } = require("../db");

const CLOSED_STATUSES = [
  "CLOSED",
  "EXITED_TARGET",
  "EXITED_SL",
  "EXITED_MANUAL",
  "ENTRY_FAILED",
  "GUARD_FAILED",
];

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function computeDrawdown(series) {
  let peak = 0;
  let maxDd = 0;
  let cum = 0;
  for (const pnl of series) {
    cum += pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

function computeSharpe(series) {
  if (!series.length) return null;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const variance =
    series.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) /
    Math.max(1, series.length - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std === 0) return null;
  return mean / std;
}

function aggregateTrades(trades) {
  const pnls = [];
  const holdTimes = [];
  let wins = 0;

  for (const t of trades) {
    const pnl =
      safeNumber(t?.pnlNetAfterEstCostsInr) ?? safeNumber(t?.pnlGrossInr) ?? 0;
    pnls.push(pnl);
    if (pnl > 0) wins += 1;

    const start = t?.createdAt ? new Date(t.createdAt).getTime() : null;
    const end = t?.closedAt ? new Date(t.closedAt).getTime() : null;
    if (start && end && end > start) {
      holdTimes.push(end - start);
    }
  }

  const expectancy = pnls.length
    ? pnls.reduce((a, b) => a + b, 0) / pnls.length
    : null;

  return {
    trades: trades.length,
    winRate: trades.length ? wins / trades.length : null,
    expectancy,
    sharpe: computeSharpe(pnls),
    maxDrawdownInr: computeDrawdown(pnls),
    avgHoldMs: holdTimes.length
      ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length
      : null,
  };
}

async function getStrategyKpis({ limit = 500 } = {}) {
  const db = getDb();
  const rows = await db
    .collection("trades")
    .find({ status: { $in: CLOSED_STATUSES } })
    .sort({ closedAt: -1 })
    .limit(Math.max(1, Math.min(limit, 2000)))
    .toArray();

  const byStrategy = new Map();
  for (const t of rows) {
    const key = t.strategyId || "UNKNOWN";
    if (!byStrategy.has(key)) byStrategy.set(key, []);
    byStrategy.get(key).push(t);
  }

  const strategies = Array.from(byStrategy.entries()).map(([key, trades]) => ({
    strategyId: key,
    ...aggregateTrades(trades),
  }));

  return {
    overall: aggregateTrades(rows),
    strategies: strategies.sort((a, b) => b.trades - a.trades),
    sampleSize: rows.length,
  };
}

module.exports = { getStrategyKpis };
