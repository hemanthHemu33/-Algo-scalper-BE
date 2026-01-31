const { env } = require("../config");
const { enabledStrategyIds, runStrategy } = require("./registry");
const { pickStrategies } = require("./selector");
const { telemetry } = require("../telemetry/signalTelemetry");

function enabledIntervals() {
  return String(env.SIGNAL_INTERVALS || "1")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Replay-friendly version of evaluateOnCandleClose:
 * - Uses provided candles array (does NOT hit Mongo)
 * - Optional telemetry recording (disabled by default to avoid polluting production metrics)
 */
function evaluateOnCandles({
  candles,
  intervalMin,
  instrument_token = null,
  now = new Date(),
  recordTelemetry = false,
}) {
  const allow = enabledIntervals();
  if (!allow.includes(Number(intervalMin))) return null;

  if (!candles || candles.length < 50) return null;

  const last = candles[candles.length - 1];

  let ids = enabledStrategyIds();
  if (!ids.length) return null;

  let sel = null;
  if (String(env.STRATEGY_SELECTOR_ENABLED || "false") === "true") {
    sel = pickStrategies({ candles, env, now });
    if (sel?.strategyIds?.length) ids = sel.strategyIds;
  }

  const signals = [];
  for (const id of ids) {
    const res = runStrategy(id, candles, { intervalMin });
    if (res) {
      signals.push(res);

      if (recordTelemetry) {
        telemetry.recordCandidate({
          strategyId: res.strategyId,
          strategyStyle: res.strategyStyle,
          side: res.side,
          confidence: res.confidence,
          instrument_token:
            instrument_token == null ? null : Number(instrument_token),
          intervalMin: Number(intervalMin),
          ts: last?.ts,
        });
      }
    }
  }
  if (!signals.length) return null;

  // Pick the highest-confidence signal (tie-breaker: earliest in STRATEGIES list)
  signals.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  const best = signals[0];

  // Reject synthetic candles if requested
  if (String(env.ALLOW_SYNTHETIC_SIGNALS || "false") !== "true") {
    if (last?.source && last.source !== "live") return null;
    if (last?.synthetic) return null;
  }

  if (recordTelemetry) {
    telemetry.recordDecision({
      signal: {
        strategyId: best.strategyId,
        strategyStyle: best.strategyStyle,
        side: best.side,
        intervalMin: Number(intervalMin),
      },
      token: instrument_token == null ? null : Number(instrument_token),
      outcome: "SELECTED",
      stage: "selector",
      reason: best.reason,
      meta: {
        confidence: Number(best.confidence || 0),
        regime: sel?.regime || null,
        replay: true,
      },
    });
  }

  return {
    strategyId: best.strategyId || env.STRATEGY_ID,
    strategyStyle: best.strategyStyle || null,
    strategyFamily: best.strategyFamily || null,
    confidence: Number(best.confidence || 0),
    instrument_token: instrument_token == null ? null : Number(instrument_token),
    intervalMin: Number(intervalMin),
    regime: sel?.regime || null,
    regimeMeta: sel?.meta || null,
    side: best.side,
    reason: best.reason,
    candle: last
      ? {
          interval_min: Number(intervalMin),
          ts: last.ts,
          open: last.open,
          high: last.high,
          low: last.low,
          close: last.close,
          volume: last.volume,
          source: last.source,
          synthetic: last.synthetic,
        }
      : null,
    ts: last?.ts || null,
  };
}

module.exports = { evaluateOnCandles };
