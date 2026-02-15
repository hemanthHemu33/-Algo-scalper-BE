#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const { env } = require("../src/config");
const { connectMongo, getDb } = require("../src/db");
const { collectionName } = require("../src/market/candleStore");
const { evaluateOnCandles } = require("../src/strategy/replayEngine");
const { computeDynamicExitPlan } = require("../src/trading/dynamicExitManager");
const { estimateRoundTripCostInr } = require("../src/trading/costModel");
const { createBacktestClock } = require("../src/backtest/clock");
const { buildOptionBacktestProvider } = require("../src/backtest/optionBacktest");
const {
  calibrateFromRecentTrades,
  applyExecutionRealism,
  seeded,
} = require("../src/backtest/executionRealism");

function getArg(name, def = null) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : def;
}

function n(v, d) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function toMs(v, fb = null) {
  const d = new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? t : fb;
}

function pickEnvSnapshot() {
  const prefixes = [
    "STRATEGY_",
    "RR_",
    "RISK_",
    "DYN_",
    "OPT_",
    "COST_",
    "CANDLE_",
    "FNO_",
    "MIN_GREEN_",
    "TIME_STOP_",
    "BE_",
    "TRAIL_",
  ];
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (prefixes.some((p) => k.startsWith(p)) || ["NODE_ENV", "ALLOW_SYNTHETIC_SIGNALS"].includes(k)) {
      out[k] = v;
    }
  }
  return out;
}

function gitHash() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function resolveExitPrice({ side, candle, stopLoss, targetPrice, conservative = true }) {
  const high = Number(candle?.high);
  const low = Number(candle?.low);
  const close = Number(candle?.close);

  const hasStop = Number.isFinite(stopLoss);
  const hasTarget = Number.isFinite(targetPrice);

  if (side === "BUY") {
    const stopHit = hasStop && Number.isFinite(low) && low <= stopLoss;
    const targetHit = hasTarget && Number.isFinite(high) && high >= targetPrice;
    if (stopHit && targetHit) {
      return { hit: true, reason: conservative ? "STOPLOSS" : "TARGET", price: conservative ? stopLoss : targetPrice };
    }
    if (stopHit) return { hit: true, reason: "STOPLOSS", price: stopLoss };
    if (targetHit) return { hit: true, reason: "TARGET", price: targetPrice };
  } else {
    const stopHit = hasStop && Number.isFinite(high) && high >= stopLoss;
    const targetHit = hasTarget && Number.isFinite(low) && low <= targetPrice;
    if (stopHit && targetHit) {
      return { hit: true, reason: conservative ? "STOPLOSS" : "TARGET", price: conservative ? stopLoss : targetPrice };
    }
    if (stopHit) return { hit: true, reason: "STOPLOSS", price: stopLoss };
    if (targetHit) return { hit: true, reason: "TARGET", price: targetPrice };
  }

  if (Number.isFinite(close)) return { hit: false, reason: null, price: close };
  return { hit: false, reason: null, price: null };
}

function applyTradePatch(trade, patch) {
  if (!trade || !patch || typeof patch !== "object") return trade;
  for (const [k, v] of Object.entries(patch)) {
    trade[k] = v;
  }
  return trade;
}

function findCandleAtTs(candles, ts) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const want = new Date(ts).getTime();
  if (!Number.isFinite(want)) return null;
  return candles.find((c) => new Date(c.ts).getTime() === want) || null;
}

async function main() {
  const mode = String(getArg("--mode", "EQ")).toUpperCase();
  const token = n(getArg("--token"), NaN);
  const intervalMin = n(getArg("--interval"), 1);
  const fromMs = toMs(getArg("--from"), null);
  const toMsArg = toMs(getArg("--to"), null);
  const limit = n(getArg("--limit"), 3000);
  const warmup = Math.max(50, n(getArg("--warmup"), 80));
  const qty = Math.max(1, n(getArg("--qty"), 1));
  const rrTarget = Math.max(0.5, n(getArg("--rr"), n(env.RR_TARGET, 1.4)));
  const slPct = Math.max(0.1, n(getArg("--slPct"), 0.7));
  const slipBps = Math.max(0, n(getArg("--slippageBps"), 3));
  const seed = n(getArg("--seed", "42"), 42);
  const dynamicContracts = String(getArg("--dynamicContracts", "false")) === "true";
  const optionType = String(getArg("--optionType", "CE")).toUpperCase();
  const scanSteps = Math.max(0, n(getArg("--scanSteps"), 2));
  const strikeStep = Math.max(1, n(getArg("--strikeStep"), 50));
  const greeksFilter = String(getArg("--greeksFilter", "false")) === "true";
  const minDelta = Math.max(0, n(getArg("--minDelta"), 0.2));
  const maxDelta = Math.min(1, n(getArg("--maxDelta"), 0.85));
  const ivMax = Math.max(0.1, n(getArg("--ivMax"), 2.5));
  const execRealism = String(getArg("--execRealism", "true")) === "true";
  const calibrationDays = Math.max(1, n(getArg("--calibrationDays"), 5));
  const partialFillProbability = clamp01(n(getArg("--partialFillProbability"), 0.15));
  const minPartialFillRatio = clamp01(n(getArg("--minPartialFillRatio"), 0.35));
  const out = getArg("--out", `bt_result_${Date.now()}.json`);

  if (!Number.isFinite(token)) throw new Error("Missing --token=<instrument_token>");

  await connectMongo();
  const db = getDb();
  const col = db.collection(collectionName(intervalMin));

  const q = { instrument_token: Number(token) };
  if (fromMs || toMsArg) {
    q.ts = {};
    if (fromMs) q.ts.$gte = new Date(fromMs);
    if (toMsArg) q.ts.$lte = new Date(toMsArg);
  }

  const candles = await col.find(q).sort({ ts: 1 }).limit(limit).toArray();
  if (!candles.length) throw new Error("No candles found for query");

  const optionProvider =
    mode === "OPT" && dynamicContracts
      ? await buildOptionBacktestProvider({
          db,
          intervalMin,
          from: fromMs ? new Date(fromMs) : null,
          to: toMsArg ? new Date(toMsArg) : null,
          underlyingToken: token,
          underlyingTradingsymbol: getArg("--underlying", ""),
          optionType,
          strikeStep,
          scanSteps,
          greeks: { enabled: greeksFilter, minDelta, maxDelta, ivMax },
        })
      : null;

  const execCalibration = execRealism
    ? await calibrateFromRecentTrades({ db, days: calibrationDays })
    : null;
  const rng = seeded(seed);

  const clock = createBacktestClock(candles[0].ts);
  const trades = [];
  let openTrade = null;
  let equity = 0;
  let peak = 0;
  let maxDD = 0;

  for (let i = warmup; i < candles.length; i += 1) {
    const candle = candles[i];
    clock.set(candle.ts);
    const slice = candles.slice(0, i + 1);
    const nowMs = clock.nowMs();

    if (openTrade) {
      const optionCandles =
        mode === "OPT" && openTrade?.contractToken
          ? optionProvider?.getCandlesByToken?.(openTrade.contractToken) || []
          : [];
      const tradedCandle =
        mode === "OPT" && openTrade?.contractToken
          ? findCandleAtTs(optionCandles, candle.ts)
          : candle;
      const managedCandles =
        mode === "OPT" && openTrade?.contractToken
          ? optionCandles.filter((c) => new Date(c.ts).getTime() <= nowMs)
          : slice;
      const ltp = Number(tradedCandle?.close);
      if (Number.isFinite(ltp) && ltp > 0) openTrade.lastLtp = ltp;

      const plan = computeDynamicExitPlan({
        trade: openTrade,
        ltp: Number.isFinite(ltp) && ltp > 0 ? ltp : Number(openTrade.lastLtp),
        candles: managedCandles,
        nowTs: nowMs,
        env,
      });

      applyTradePatch(openTrade, plan?.tradePatch);
      openTrade.updatedAt = new Date(nowMs);

      if (Number.isFinite(Number(plan?.sl?.stopLoss))) openTrade.stopLoss = Number(plan.sl.stopLoss);
      if (Number.isFinite(Number(plan?.target?.targetPrice))) openTrade.targetPrice = Number(plan.target.targetPrice);

      const pathExit = resolveExitPrice({
        side: openTrade.side,
        candle: tradedCandle || candle,
        stopLoss: openTrade.stopLoss,
        targetPrice: openTrade.targetPrice,
        conservative: true,
      });

      const forceExit = plan?.action?.exitNow;
      if (pathExit.hit || forceExit) {
        const basePx = forceExit
          ? Number.isFinite(ltp) && ltp > 0
            ? ltp
            : Number(openTrade.lastLtp || candle.close)
          : pathExit.price;
        const exec = execRealism
          ? applyExecutionRealism({
              side: openTrade.side === "BUY" ? "SELL" : "BUY",
              intendedPrice: basePx,
              candle: tradedCandle || candle,
              qty: openTrade.qty,
              rand: rng,
              model: {
                spreadBps: execCalibration?.avgSpreadBps ?? 0,
                slippageBps: (execCalibration?.avgEntrySlipBps ?? 0) + slipBps,
                partialFillProbability,
                minPartialFillRatio,
                latencyBars: 0,
              },
            })
          : null;
        const exitPrice = Number(exec?.avgFillPrice || basePx);
        const filledQty = Number(exec?.filledQty || openTrade.qty);
        const signed = openTrade.side === "BUY" ? 1 : -1;
        const grossPnl = (exitPrice - openTrade.entryPrice) * filledQty * signed;
        const costs = estimateRoundTripCostInr({
          entryPrice: (openTrade.entryPrice + exitPrice) / 2,
          qty: filledQty,
          spreadBps: 0,
          env,
          instrument: openTrade.instrument,
        });
        const netPnl = grossPnl - Number(costs.estCostInr || 0);

        equity += netPnl;
        peak = Math.max(peak, equity);
        maxDD = Math.min(maxDD, equity - peak);

        trades.push({
          ...openTrade,
          exitTs: candle.ts,
          exitReason: forceExit ? String(plan?.action?.reason || "DYNAMIC_EXIT") : pathExit.reason,
          exitPrice,
          grossPnl,
          estCostInr: Number(costs.estCostInr || 0),
          netPnl,
          executionModel: exec || null,
          holdCandles: i - openTrade.entryIdx,
        });
        openTrade = null;
      }
    }

    if (!openTrade) {
      const sig = evaluateOnCandles({
        candles: slice,
        intervalMin,
        instrument_token: token,
        now: clock.nowDate(),
        recordTelemetry: false,
      });
      if (!sig) continue;

      const side = String(sig.side || "").toUpperCase();
      if (side !== "BUY" && side !== "SELL") continue;

      const baseCandle = candle;
      const selectedContract =
        mode === "OPT" && optionProvider?.ready
          ? optionProvider.selectContract({
              ts: baseCandle.ts,
              underlyingPrice: Number(baseCandle.close),
            })
          : null;

      const tradedCandle =
        mode === "OPT" && selectedContract?.selectedToken
          ? optionProvider
              ?.getCandlesByToken(selectedContract.selectedToken)
              ?.find((c) => new Date(c.ts).getTime() === new Date(baseCandle.ts).getTime()) ||
            null
          : baseCandle;

      const rawEntry = Number(tradedCandle?.close);
      if (!Number.isFinite(rawEntry) || rawEntry <= 0) continue;

      const exec = execRealism
        ? applyExecutionRealism({
            side,
            intendedPrice: rawEntry,
            candle: tradedCandle || baseCandle,
            qty,
            rand: rng,
            model: {
              spreadBps: execCalibration?.avgSpreadBps ?? 0,
              slippageBps: (execCalibration?.avgEntrySlipBps ?? 0) + slipBps,
              partialFillProbability,
              minPartialFillRatio,
              latencyBars: Math.round((execCalibration?.avgFillLatencyMs || 0) / (intervalMin * 60 * 1000)),
            },
          })
        : null;

      const entryPrice = Number(exec?.avgFillPrice || rawEntry);
      const filledQty = Number(exec?.filledQty || qty);
      const riskPts = Math.max(0.05, entryPrice * (slPct / 100));
      const stopLoss = side === "BUY" ? entryPrice - riskPts : entryPrice + riskPts;
      const targetPrice = side === "BUY" ? entryPrice + rrTarget * riskPts : entryPrice - rrTarget * riskPts;

      openTrade = {
        side,
        qty: filledQty,
        entryTs: candle.ts,
        entryFilledAt: new Date(candle.ts),
        createdAt: new Date(candle.ts),
        updatedAt: new Date(candle.ts),
        entryIdx: i,
        entryPrice,
        lastLtp: entryPrice,
        stopLoss,
        initialStopLoss: stopLoss,
        targetPrice,
        rr: rrTarget,
        strategyId: sig.strategyId,
        confidence: Number(sig.confidence || 0),
        signalReason: sig.reason || null,
        mode,
        contractToken: selectedContract?.selectedToken || Number(token),
        optionSnapshot: selectedContract?.snapshot || null,
        executionModel: exec || null,
        instrument: { instrument_token: Number(token), tick_size: 0.05 },
      };
    }
  }

  const wins = trades.filter((t) => Number(t.netPnl) > 0).length;
  const losses = trades.filter((t) => Number(t.netPnl) <= 0).length;
  const totalNet = trades.reduce((a, t) => a + Number(t.netPnl || 0), 0);
  const totalCost = trades.reduce((a, t) => a + Number(t.estCostInr || 0), 0);

  const run = {
    runAt: new Date().toISOString(),
    token,
    intervalMin,
    range: {
      from: fromMs ? new Date(fromMs).toISOString() : null,
      to: toMsArg ? new Date(toMsArg).toISOString() : null,
      loadedCandles: candles.length,
    },
    seed,
    gitHash: gitHash(),
    configSnapshot: pickEnvSnapshot(),
    params: { warmup, qty, rrTarget, slPct, slippageBps: slipBps },
    phase3: {
      mode,
      dynamicContracts,
      optionType,
      providerReady: !!optionProvider?.ready,
      providerStats: optionProvider?.stats || null,
      greeksFilter,
      greeksBounds: { minDelta, maxDelta, ivMax },
    },
    phase4: {
      executionRealism: execRealism,
      calibrationDays,
      calibration: execCalibration,
      partialFillProbability,
      minPartialFillRatio,
    },
    metrics: {
      trades: trades.length,
      wins,
      losses,
      winRate: trades.length ? (wins / trades.length) * 100 : 0,
      totalNetPnl: totalNet,
      totalEstimatedCostInr: totalCost,
      maxDrawdownInr: Math.abs(maxDD),
      avgNetPerTrade: trades.length ? totalNet / trades.length : 0,
    },
    trades,
  };

  await db.collection("bt_runs").insertOne(run);

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(run, null, 2));
  console.log(`Backtest complete: ${outPath}`);
  console.log(run.metrics);
}

function clamp01(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

main().catch((err) => {
  console.error("bt_run failed", err);
  process.exit(1);
});
