#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { DateTime } = require("luxon");

const { env } = require("../src/config");
const { connectMongo, getDb } = require("../src/db");
const { collectionName } = require("../src/market/candleStore");
const { getSessionForDateTime, buildBoundsForToday } = require("../src/market/marketCalendar");
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
const { simulateOrderLifecycle } = require("../src/backtest/eventBrokerSimulator");

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

function isTargetEnabledForMode(mode) {
  if (String(mode).toUpperCase() === "OPT") {
    return String(env.OPT_TP_ENABLED || "false") === "true";
  }
  return true;
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
  const eventBroker = String(getArg("--eventBroker", "true")) === "true";
  const calibrationDays = Math.max(1, n(getArg("--calibrationDays"), 5));
  const calibrationMode = String(getArg("--calibrationMode", "fixed")).toLowerCase();
  const dataQualityMode = String(getArg("--dataQuality", "strict")).toLowerCase(); // off|warn|strict
  const forceEodExit = String(getArg("--forceEodExit", "false")) === "true";
  const timezone = String(getArg("--timezone", env.CANDLE_TZ || "Asia/Kolkata"));
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
  const tokenInstrument = await db.collection("instruments_cache").findOne({ instrument_token: Number(token) });

  const dataQuality = dataQualityMode === "off" ? null : assessDataQuality({ candles, intervalMin, timezone });
  const dataIssues = Number(dataQuality?.summary?.totalIssues || 0);
  if (dataIssues > 0 && dataQualityMode === "strict") {
    throw new Error(`Data quality validation failed (${dataIssues} issues). Re-run with --dataQuality=warn to inspect.`);
  }
  if (dataIssues > 0 && dataQualityMode === "warn") {
    console.warn("[bt_run] data quality guardrails warnings", dataQuality.summary);
  }

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
    ? calibrationMode === "recent"
      ? { ...(await calibrateFromRecentTrades({ db, days: calibrationDays })), source: "recent_trades" }
      : buildCalibrationFallback()
    : null;
  const rng = seeded(seed);

  const clock = createBacktestClock(candles[0].ts);
  const trades = [];
  const equityCurve = [];
  let openTrade = null;
  let pendingEntry = null;
  let pendingExit = null;
  let equity = 0;
  let peak = 0;
  let maxDD = 0;

  const replaySlice = [];
  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i];
    replaySlice.push(candle);
    if (i < warmup) continue;
    clock.set(candle.ts);
    const nowMs = clock.nowMs();

    if (pendingEntry && !openTrade && i >= pendingEntry.executeAtIdx) {
      const baseCandle = candle;
      const tradedCandle =
        mode === "OPT" && pendingEntry.selectedContract?.selectedToken
          ? optionProvider?.getCandleAtTs?.(pendingEntry.selectedContract.selectedToken, baseCandle.ts) || null
          : baseCandle;
      const rawEntry = Number(tradedCandle?.close);
      if (Number.isFinite(rawEntry) && rawEntry > 0) {
        const entryExecModel = {
          spreadBps: execCalibration?.avgSpreadBps ?? 0,
          slippageBps: (execCalibration?.avgEntrySlipBps ?? 0) + slipBps,
          partialFillProbability,
          minPartialFillRatio,
          eventBroker,
          latencyBars: 0,
          tickSize: Number(pendingEntry.selectedContract?.selected?.instrument?.tick_size || 0.05),
        };
        const exec = execRealism
          ? eventBroker
            ? simulateOrderLifecycle({
                side: pendingEntry.side,
                intent: { type: "MARKET", price: rawEntry },
                candle: tradedCandle || baseCandle,
                qty: pendingEntry.qty,
                nowTs: nowMs,
                model: entryExecModel,
                rand: rng,
              })
            : applyExecutionRealism({
                side: pendingEntry.side,
                intendedPrice: rawEntry,
                candle: tradedCandle || baseCandle,
                qty: pendingEntry.qty,
                rand: rng,
                model: entryExecModel,
              })
          : null;

        const entryPrice = Number(exec?.avgFillPrice || rawEntry);
        const filledQty = Number(exec?.filledQty || pendingEntry.qty);
        if (filledQty > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
          const riskPts = Math.max(0.05, entryPrice * (slPct / 100));
          const stopLoss = pendingEntry.side === "BUY" ? entryPrice - riskPts : entryPrice + riskPts;
          const targetEnabled = isTargetEnabledForMode(mode);
          const targetPrice = targetEnabled
            ? pendingEntry.side === "BUY"
              ? entryPrice + rrTarget * riskPts
              : entryPrice - rrTarget * riskPts
            : null;

          openTrade = {
            side: pendingEntry.side,
            qty: filledQty,
            initialQty: filledQty,
            requestedQty: pendingEntry.qty,
            entryTs: candle.ts,
            entryPlacedAt: pendingEntry.signalTs,
            entryFilledAt: candle.ts,
            createdAt: candle.ts,
            updatedAt: candle.ts,
            entryIdx: i,
            entryPrice,
            lastLtp: entryPrice,
            stopLoss,
            initialStopLoss: stopLoss,
            targetPrice,
            rr: rrTarget,
            strategyId: pendingEntry.sig.strategyId,
            confidence: Number(pendingEntry.sig.confidence || 0),
            signalReason: pendingEntry.sig.reason || null,
            mode,
            contractToken: pendingEntry.selectedContract?.selectedToken || Number(token),
            optionSnapshot: pendingEntry.selectedContract?.snapshot || null,
            option_meta:
              mode === "OPT"
                ? {
                    optType: optionType,
                    strike: Number(pendingEntry.selectedContract?.selected?.strike || 0) || null,
                    expiry: pendingEntry.selectedContract?.selected?.expiryISO || null,
                    underlyingToken: Number(token),
                  }
                : null,
            executionModel: exec || null,
            entryExecutionModel: exec || null,
            instrument: instrumentFromContract({
              fallbackToken: Number(token),
              fallbackInstrument: tokenInstrument,
              selected: pendingEntry.selectedContract?.selected,
              mode,
            }),
            exitFills: [],
            realizedGrossPnl: 0,
            realizedCostInr: 0,
            realizedNetPnl: 0,
          };
        }
      }
      pendingEntry = null;
    }

    if (openTrade) {
      const underlyingCandle = candle;
      const tradedCandle =
        mode === "OPT" && openTrade?.contractToken
          ? optionProvider?.getCandleAtTs?.(openTrade.contractToken, underlyingCandle.ts) || null
          : underlyingCandle;
      const managedCandles =
        mode === "OPT" && openTrade?.contractToken
          ? upsertOptionManagedCandles({
              optionProvider,
              token: openTrade.contractToken,
              ts: underlyingCandle.ts,
              trade: openTrade,
            })
          : replaySlice;
      const ltp = Number(tradedCandle?.close);
      if (Number.isFinite(ltp) && ltp > 0) openTrade.lastLtp = ltp;

      const plan = computeDynamicExitPlan({
        trade: openTrade,
        ltp: Number.isFinite(ltp) && ltp > 0 ? ltp : Number(openTrade.lastLtp),
        candles: managedCandles,
        nowTs: nowMs,
        env,
        underlyingLtp: Number(underlyingCandle.close),
      });

      if (plan?.tradePatch && Object.keys(plan.tradePatch).length) Object.assign(openTrade, plan.tradePatch);
      openTrade.updatedAt = new Date(nowMs);

      if (Number.isFinite(Number(plan?.sl?.stopLoss))) openTrade.stopLoss = Number(plan.sl.stopLoss);
      if (Number.isFinite(Number(plan?.target?.targetPrice))) openTrade.targetPrice = Number(plan.target.targetPrice);

      const pricePathCandle =
        tradedCandle ||
        (Number.isFinite(Number(openTrade.lastLtp))
          ? {
              open: openTrade.lastLtp,
              high: openTrade.lastLtp,
              low: openTrade.lastLtp,
              close: openTrade.lastLtp,
              ts: underlyingCandle.ts,
            }
          : null);

      const pathExit = resolveExitPrice({
        side: openTrade.side,
        candle: pricePathCandle,
        stopLoss: openTrade.stopLoss,
        targetPrice: isTargetEnabledForMode(mode) ? openTrade.targetPrice : null,
        conservative: true,
      });

      if (!pendingExit) {
        const forceExit = plan?.action?.exitNow;
        const eodBoundary = forceEodExit ? evaluateEodBoundary({ candles, idx: i, intervalMin, timezone }) : null;
        if (pathExit.hit || forceExit || eodBoundary?.shouldExitNow) {
          const basePx = forceExit
            ? Number.isFinite(ltp) && ltp > 0
              ? ltp
              : Number(openTrade.lastLtp || underlyingCandle.close)
            : pathExit.price;
          const exitBasePx =
            eodBoundary?.shouldExitNow && !pathExit.hit && !forceExit
              ? Number.isFinite(ltp) && ltp > 0
                ? ltp
                : Number(openTrade.lastLtp || underlyingCandle.close)
              : basePx;
          const latencyBars = Math.max(0, Math.round((execCalibration?.avgFillLatencyMs || 0) / (intervalMin * 60 * 1000)));
          pendingExit = {
            executeAtIdx: i + latencyBars,
            basePx: exitBasePx,
            reason: forceExit
              ? String(plan?.action?.reason || "DYNAMIC_EXIT")
              : eodBoundary?.shouldExitNow && !pathExit.hit
                ? eodBoundary.reason
                : pathExit.reason,
            triggeredAt: underlyingCandle.ts,
          };
        }
      }

      if (pendingExit && i >= pendingExit.executeAtIdx) {
        const execModel = {
          spreadBps: execCalibration?.avgSpreadBps ?? 0,
          slippageBps: (execCalibration?.avgEntrySlipBps ?? 0) + slipBps,
          partialFillProbability,
          minPartialFillRatio,
          eventBroker,
          latencyBars: 0,
          tickSize: openTrade?.instrument?.tick_size || 0.05,
        };
        const exec = execRealism
          ? eventBroker
            ? simulateOrderLifecycle({
                side: openTrade.side === "BUY" ? "SELL" : "BUY",
                intent: { type: "MARKET", price: pendingExit.basePx },
                candle: pricePathCandle || underlyingCandle,
                qty: openTrade.qty,
                nowTs: nowMs,
                model: execModel,
                rand: rng,
              })
            : applyExecutionRealism({
                side: openTrade.side === "BUY" ? "SELL" : "BUY",
                intendedPrice: pendingExit.basePx,
                candle: pricePathCandle || underlyingCandle,
                qty: openTrade.qty,
                rand: rng,
                model: execModel,
              })
          : null;

        const exitPrice = Number(exec?.avgFillPrice || pendingExit.basePx);
        const filledQty = Math.max(0, Math.min(Number(openTrade.qty || 0), Number(exec?.filledQty || openTrade.qty)));
        if (filledQty > 0 && Number.isFinite(exitPrice)) {
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

          openTrade.qty -= filledQty;
          openTrade.realizedGrossPnl = Number(openTrade.realizedGrossPnl || 0) + grossPnl;
          openTrade.realizedCostInr = Number(openTrade.realizedCostInr || 0) + Number(costs.estCostInr || 0);
          openTrade.realizedNetPnl = Number(openTrade.realizedNetPnl || 0) + netPnl;
          openTrade.exitFills.push({
            ts: underlyingCandle.ts,
            qty: filledQty,
            price: exitPrice,
            reason: pendingExit.reason,
            executionModel: exec || null,
          });

          equity += netPnl;
          peak = Math.max(peak, equity);
          maxDD = Math.min(maxDD, equity - peak);
          equityCurve.push({ ts: underlyingCandle.ts, equity, drawdown: equity - peak });

          if (openTrade.qty <= 0) {
            const finalizedTrade = { ...openTrade };
            delete finalizedTrade._managedCandles;
            delete finalizedTrade._lastManagedTs;
            trades.push({
              ...finalizedTrade,
              qty: Number(openTrade.initialQty || 0),
              remainingQty: 0,
              exitTs: underlyingCandle.ts,
              exitReason: pendingExit.reason,
              exitPrice,
              grossPnl: Number(openTrade.realizedGrossPnl || 0),
              estCostInr: Number(openTrade.realizedCostInr || 0),
              netPnl: Number(openTrade.realizedNetPnl || 0),
              executionModel: exec || null,
              holdCandles: i - openTrade.entryIdx,
            });
            openTrade = null;
          }
        }
        pendingExit = null;
      }
    }

    if (!openTrade && !pendingEntry) {
      const sig = evaluateOnCandles({
        candles: replaySlice,
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

      if (mode === "OPT" && dynamicContracts && !selectedContract?.selectedToken) continue;

      const latencyBars = Math.max(0, Math.round((execCalibration?.avgFillLatencyMs || 0) / (intervalMin * 60 * 1000)));
      pendingEntry = {
        executeAtIdx: i + latencyBars,
        signalTs: candle.ts,
        side,
        qty,
        sig,
        selectedContract,
      };
    }
  }

  if (openTrade && forceEodExit) {
    const last = candles[candles.length - 1] || null;
    const exitPrice = Number(last?.close || openTrade.lastLtp || openTrade.entryPrice);
    const filledQty = Number(openTrade.qty || 0);
    if (filledQty > 0 && Number.isFinite(exitPrice) && exitPrice > 0) {
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
      equityCurve.push({ ts: last?.ts || new Date(), equity, drawdown: equity - peak });

      const finalizedTrade = { ...openTrade };
      delete finalizedTrade._managedCandles;
      delete finalizedTrade._lastManagedTs;
      trades.push({
        ...finalizedTrade,
        qty: Number(openTrade.initialQty || openTrade.qty || 0),
        remainingQty: 0,
        exitTs: last?.ts || new Date(),
        exitReason: "FORCE_EOD_END",
        exitPrice,
        grossPnl,
        estCostInr: Number(costs.estCostInr || 0),
        netPnl,
        holdCandles: candles.length - 1 - Number(openTrade.entryIdx || 0),
      });
    }
    openTrade = null;
    pendingExit = null;
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
    params: { warmup, qty, rrTarget, slPct, slippageBps: slipBps, eventBroker, calibrationMode, dataQualityMode, forceEodExit, timezone },
    dataQuality: dataQuality || { mode: "off" },
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
      calibrationMode,
      calibration: execCalibration,
      deterministic: calibrationMode !== "recent",
      determinismNote:
        calibrationMode === "recent"
          ? "Calibration derives from recent DB trades; results can vary when history changes."
          : "Deterministic execution calibration (fixed fallback mode).",
      partialFillProbability,
      minPartialFillRatio,
      eventBroker,
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
    analytics: {
      equityCurve,
      perDay: aggregatePerDay(trades),
      perStrategy: aggregatePerStrategy(trades),
    },
    trades,
  };

  await db.collection("bt_runs").insertOne(run);

  const outPath = path.resolve(process.cwd(), out);
  fs.writeFileSync(outPath, JSON.stringify(run, null, 2));
  console.log(`Backtest complete: ${outPath}`);
  console.log(run.metrics);
}

function aggregatePerDay(trades) {
  const map = new Map();
  for (const t of trades || []) {
    const key = new Date(t.exitTs || t.entryTs || Date.now()).toISOString().slice(0, 10);
    if (!map.has(key)) map.set(key, { day: key, trades: 0, wins: 0, netPnl: 0, grossPnl: 0, costs: 0 });
    const row = map.get(key);
    row.trades += 1;
    if (Number(t.netPnl) > 0) row.wins += 1;
    row.netPnl += Number(t.netPnl || 0);
    row.grossPnl += Number(t.grossPnl || 0);
    row.costs += Number(t.estCostInr || 0);
  }
  return Array.from(map.values()).map((r) => ({ ...r, winRate: r.trades ? (r.wins / r.trades) * 100 : 0 }));
}

function aggregatePerStrategy(trades) {
  const map = new Map();
  for (const t of trades || []) {
    const key = String(t.strategyId || 'UNKNOWN');
    if (!map.has(key)) map.set(key, { strategyId: key, trades: 0, wins: 0, netPnl: 0 });
    const row = map.get(key);
    row.trades += 1;
    if (Number(t.netPnl) > 0) row.wins += 1;
    row.netPnl += Number(t.netPnl || 0);
  }
  return Array.from(map.values()).map((r) => ({ ...r, winRate: r.trades ? (r.wins / r.trades) * 100 : 0 }));
}

function clamp01(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function buildCalibrationFallback() {
  return {
    sampleSize: 0,
    avgEntrySlipBps: 0,
    avgSpreadBps: 0,
    avgFillRatio: 1,
    avgFillLatencyMs: 0,
    source: "fallback",
  };
}

function assessDataQuality({ candles, intervalMin, timezone }) {
  const intervalMs = Math.max(1, Number(intervalMin)) * 60 * 1000;
  const issues = {
    nonMonotonicTs: [],
    intervalAlignment: [],
    gaps: [],
    sessionBoundary: [],
  };

  for (let i = 0; i < candles.length; i += 1) {
    const cur = candles[i];
    const ts = new Date(cur?.ts).getTime();
    const dt = DateTime.fromJSDate(new Date(cur.ts), { zone: timezone });

    if (!dt.isValid || dt.second !== 0 || dt.millisecond !== 0 || dt.minute % intervalMin !== 0) {
      issues.intervalAlignment.push({ idx: i, ts: cur?.ts || null });
    }

    const closeTs = dt.plus({ minutes: Math.max(1, intervalMin) });
    const session = getSessionForDateTime(closeTs);
    const { open, close } = buildBoundsForToday(session, closeTs);
    const inSession =
      session.allowTradingDay &&
      open?.isValid &&
      close?.isValid &&
      closeTs.toMillis() >= open.toMillis() &&
      closeTs.toMillis() <= close.toMillis();
    if (!inSession) {
      issues.sessionBoundary.push({ idx: i, ts: cur?.ts || null, dayKey: session.dayKey });
    }

    if (i === 0) continue;
    const prev = candles[i - 1];
    const prevTs = new Date(prev?.ts).getTime();
    const diff = ts - prevTs;
    if (!Number.isFinite(ts) || !Number.isFinite(prevTs) || diff <= 0) {
      issues.nonMonotonicTs.push({ prevIdx: i - 1, idx: i, prevTs: prev?.ts || null, ts: cur?.ts || null });
      continue;
    }
    const prevDt = DateTime.fromJSDate(new Date(prev.ts), { zone: timezone });
    const sameSessionDay = prevDt.isValid && dt.isValid && prevDt.toFormat("yyyy-LL-dd") === dt.toFormat("yyyy-LL-dd");
    if (sameSessionDay && diff > intervalMs) {
      issues.gaps.push({ prevIdx: i - 1, idx: i, prevTs: prev?.ts || null, ts: cur?.ts || null, gapMs: diff - intervalMs });
    }
  }

  return {
    summary: {
      candles: candles.length,
      nonMonotonicTs: issues.nonMonotonicTs.length,
      intervalAlignment: issues.intervalAlignment.length,
      gaps: issues.gaps.length,
      sessionBoundary: issues.sessionBoundary.length,
      totalIssues:
        issues.nonMonotonicTs.length +
        issues.intervalAlignment.length +
        issues.gaps.length +
        issues.sessionBoundary.length,
    },
    samples: {
      nonMonotonicTs: issues.nonMonotonicTs.slice(0, 10),
      intervalAlignment: issues.intervalAlignment.slice(0, 10),
      gaps: issues.gaps.slice(0, 10),
      sessionBoundary: issues.sessionBoundary.slice(0, 10),
    },
  };
}

function evaluateEodBoundary({ candles, idx, intervalMin, timezone }) {
  const cur = candles[idx];
  const next = candles[idx + 1] || null;
  if (!cur) return { shouldExitNow: false, reason: null };
  if (!next) return { shouldExitNow: true, reason: "FORCE_EOD_DATA_END" };

  const curDt = DateTime.fromJSDate(new Date(cur.ts), { zone: timezone });
  const nextDt = DateTime.fromJSDate(new Date(next.ts), { zone: timezone });
  if (!curDt.isValid || !nextDt.isValid) return { shouldExitNow: false, reason: null };

  const curSession = getSessionForDateTime(curDt.plus({ minutes: intervalMin }));
  const curDay = curSession.dayKey;
  const nextDay = getSessionForDateTime(nextDt.plus({ minutes: intervalMin })).dayKey;
  if (curDay !== nextDay) return { shouldExitNow: true, reason: "FORCE_EOD_SESSION_BOUNDARY" };

  const diff = nextDt.toMillis() - curDt.toMillis();
  if (diff > intervalMin * 60 * 1000) return { shouldExitNow: true, reason: "FORCE_EOD_GAP_BOUNDARY" };

  return { shouldExitNow: false, reason: null };
}

function upsertOptionManagedCandles({ optionProvider, token, ts, trade }) {
  if (!trade || !Number.isFinite(Number(token))) return [];
  if (!Array.isArray(trade._managedCandles)) {
    trade._managedCandles = optionProvider?.getCandlesUpToTs?.(token, ts) || [];
    const lastTs = trade._managedCandles.length ? new Date(trade._managedCandles[trade._managedCandles.length - 1].ts).getTime() : null;
    trade._lastManagedTs = Number.isFinite(lastTs) ? lastTs : null;
    return trade._managedCandles;
  }

  const next = optionProvider?.getCandleAtTs?.(token, ts) || null;
  const nextTs = new Date(ts).getTime();
  if (next && Number.isFinite(nextTs) && (!Number.isFinite(trade._lastManagedTs) || nextTs > trade._lastManagedTs)) {
    trade._managedCandles.push(next);
    trade._lastManagedTs = nextTs;
  }
  return trade._managedCandles;
}

function instrumentFromContract({ fallbackToken, fallbackInstrument, selected, mode }) {
  const selectedInstrument = selected?.instrument || null;
  const inferredMode = String(mode || "").toUpperCase();
  const token = Number(selected?.token || fallbackInstrument?.instrument_token || fallbackToken);
  const tick = Number(selectedInstrument?.tick_size || fallbackInstrument?.tick_size || 0.05);
  const lot = Number(selectedInstrument?.lot_size || fallbackInstrument?.lot_size || 1);
  const tradingsymbol =
    String(selectedInstrument?.tradingsymbol || fallbackInstrument?.tradingsymbol || "").toUpperCase() || null;
  const segmentRaw =
    String(selectedInstrument?.segment || fallbackInstrument?.segment || "").toUpperCase() ||
    (inferredMode === "OPT" ? "NFO-OPT" : inferredMode === "FUT" ? "NFO-FUT" : "NSE");
  const instrumentType =
    String(selectedInstrument?.instrument_type || fallbackInstrument?.instrument_type || "").toUpperCase() ||
    (inferredMode === "OPT" ? "CE" : inferredMode === "FUT" ? "FUT" : "EQ");
  return {
    instrument_token: token,
    tick_size: Number.isFinite(tick) && tick > 0 ? tick : 0.05,
    lot_size: Number.isFinite(lot) && lot > 0 ? lot : 1,
    tradingsymbol,
    segment: segmentRaw,
    instrument_type: instrumentType,
  };
}

main().catch((err) => {
  console.error("bt_run failed", err);
  process.exit(1);
});
