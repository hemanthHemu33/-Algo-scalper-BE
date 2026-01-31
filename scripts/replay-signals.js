/*
 * PATCH-10: Signal Replay (smoke test)
 *
 * Goal:
 * - Run your strategy engine over historical candles stored in Mongo
 * - Surface what signals would have fired (strategyId, side, confidence, reason)
 * - NO broker calls, NO order placement
 *
 * Usage:
 *   node scripts/replay-signals.js --token=12602626 --interval=3 --limit=500 --warmup=80 --step=1 --minConfidence=60
 *
 * Notes:
 * - By default, synthetic/historical candles are rejected unless you set:
 *     ALLOW_SYNTHETIC_SIGNALS=true
 */

const fs = require("fs");
const path = require("path");

const { env } = require("../src/config");
const { connectMongo } = require("../src/db");
const { getRecentCandles } = require("../src/market/candleStore");
const { evaluateOnCandles } = require("../src/strategy/replayEngine");

function getArg(name, def = null) {
  const hit = process.argv.find((a) => a.startsWith(name + "="));
  if (!hit) return def;
  return hit.slice(name.length + 1);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function asNum(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function safeIso(ts) {
  try {
    const d = ts ? new Date(ts) : null;
    if (!d || Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

async function main() {
  const token = asNum(getArg("--token"), NaN);
  const intervalMin = asNum(getArg("--interval"), 1);
  const limit = asNum(getArg("--limit"), 400);
  const warmup = asNum(getArg("--warmup"), 80);
  const step = asNum(getArg("--step"), 1);
  const minConfidence = asNum(getArg("--minConfidence"), 0);
  const out = getArg("--out", null);
  const recordTelemetry = hasFlag("--telemetry");

  if (!Number.isFinite(token)) {
    console.error("Missing --token=<instrument_token>");
    process.exit(1);
  }

  await connectMongo();

  const candles = await getRecentCandles(token, intervalMin, limit);
  if (!candles || candles.length < 60) {
    console.error(
      `Not enough candles for replay: got ${candles?.length || 0}. Try increasing --limit.`
    );
    process.exit(2);
  }

  const results = [];
  const start = Math.max(50, warmup);

  for (let i = start; i < candles.length; i += Math.max(1, step)) {
    const slice = candles.slice(0, i + 1);
    const last = slice[slice.length - 1];

    const sig = evaluateOnCandles({
      candles: slice,
      intervalMin,
      instrument_token: token,
      now: last?.ts ? new Date(last.ts) : new Date(),
      recordTelemetry,
    });

    if (!sig) continue;
    if (Number(sig.confidence || 0) < minConfidence) continue;

    results.push({
      idx: i,
      ts: sig.ts || last?.ts || null,
      iso: safeIso(sig.ts || last?.ts),
      strategyId: sig.strategyId,
      side: sig.side,
      confidence: sig.confidence,
      reason: sig.reason,
      close: Number(last?.close || 0),
      regime: sig.regime || null,
    });
  }

  const byStrat = {};
  for (const r of results) byStrat[r.strategyId] = (byStrat[r.strategyId] || 0) + 1;

  console.log("\n=== Replay Summary ===");
  console.log({
    token,
    intervalMin,
    candles: candles.length,
    evaluatedSteps: Math.floor((candles.length - start) / Math.max(1, step)),
    minConfidence,
    signals: results.length,
    byStrategy: byStrat,
    allowSyntheticSignals: String(env.ALLOW_SYNTHETIC_SIGNALS || "false"),
  });

  if (out) {
    const outPath = path.resolve(process.cwd(), out);
    fs.writeFileSync(outPath, JSON.stringify({ meta: { token, intervalMin }, results }, null, 2));
    console.log(`\nWrote: ${outPath}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("Replay failed", e);
  process.exit(9);
});
