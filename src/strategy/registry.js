const { env } = require("../config");
const { emaCrossStrategy } = require("./emaCrossStrategy");
const { emaPullbackStrategy } = require("./emaPullbackStrategy");
const { breakoutStrategy } = require("./breakoutStrategy");
const { vwapReclaimStrategy } = require("./vwapReclaimStrategy");
const { orbStrategy } = require("./orbStrategy");
const { bollingerSqueezeStrategy } = require("./bollingerSqueezeStrategy");
const { rsiFadeStrategy } = require("./rsiFadeStrategy");
const { volumeSpikeStrategy } = require("./volumeSpikeStrategy");
const { fakeoutStrategy } = require("./fakeoutStrategy");
const { wickReversalStrategy } = require("./wickReversalStrategy");

/**
 * Strategy metadata (used for strategy-aware filters & telemetry).
 * - style: TREND | RANGE | OPEN
 * - family: high-level grouping for tuning/metrics
 */
const STRATEGY_META = {
  ema_cross: { style: "TREND", family: "TREND" },
  ema_pullback: { style: "TREND", family: "TREND" },
  breakout: { style: "TREND", family: "BREAKOUT" },
  vwap_reclaim: { style: "TREND", family: "VWAP" },
  orb: { style: "OPEN", family: "OPEN" },
  bb_squeeze: { style: "TREND", family: "BREAKOUT" },
  volume_spike: { style: "TREND", family: "MOMENTUM" },
  fakeout: { style: "RANGE", family: "MEAN_REVERSION" },
  rsi_fade: { style: "RANGE", family: "MEAN_REVERSION" },
  wick_reversal: { style: "RANGE", family: "MEAN_REVERSION" },
};

function getStrategyMeta(strategyId) {
  return (
    STRATEGY_META[String(strategyId || "")] || {
      style: "UNKNOWN",
      family: "UNKNOWN",
    }
  );
}

function attachMeta(strategyId, res) {
  if (!res) return null;
  const meta = getStrategyMeta(strategyId);
  return {
    ...res,
    strategyId,
    strategyStyle: meta.style,
    strategyFamily: meta.family,
  };
}

function enabledStrategyIds() {
  return String(env.STRATEGIES || "ema_cross")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function runStrategy(strategyId, candles, ctx = {}) {
  const id = String(strategyId || "").trim();
  const fast = Number(env.EMA_FAST || 9);
  const slow = Number(env.EMA_SLOW || 21);

  switch (id) {
    case "ema_cross": {
      return attachMeta(
        "ema_cross",
        emaCrossStrategy({
          candles,
          fast,
          slow,
        }),
      );
    }
    case "ema_pullback": {
      return attachMeta(
        "ema_pullback",
        emaPullbackStrategy({
          candles,
          fast,
          slow,
          pullbackBars: Number(env.PULLBACK_BARS || 5),
        }),
      );
    }
    case "breakout": {
      return attachMeta(
        "breakout",
        breakoutStrategy({
          candles,
          lookback: Number(env.BREAKOUT_LOOKBACK || 20),
          volMult: Number(env.BREAKOUT_VOL_MULT || 1.2),
          volLookback: 20,
        }),
      );
    }
    case "vwap_reclaim": {
      return attachMeta(
        "vwap_reclaim",
        vwapReclaimStrategy({
          candles,
          lookback: Number(env.VWAP_LOOKBACK || 120),
          volLookback: 20,
          volMult: Number(env.VWAP_VOL_MULT || 1.0),
          fast,
          slow,
        }),
      );
    }
    case "orb": {
      return attachMeta(
        "orb",
        orbStrategy({
          candles,
          intervalMin: Number(ctx.intervalMin || 1),
          orbMinutes: Number(env.ORB_MINUTES || 15),
          volLookback: 20,
          volMult: Number(env.ORB_VOL_MULT || 1.2),
        }),
      );
    }
    case "bb_squeeze": {
      return attachMeta(
        "bb_squeeze",
        bollingerSqueezeStrategy({
          candles,
          period: Number(env.BB_PERIOD || 20),
          stdDev: Number(env.BB_STDDEV ?? env.BB_STD ?? 2),
          squeezePct: Number(env.SQUEEZE_PCT ?? env.BB_SQUEEZE_PCT ?? 0.012),
          volLookback: 20,
          volMult: Number(
            env.SQUEEZE_VOL_MULT ?? env.BB_SQUEEZE_VOL_MULT ?? 1.1,
          ),
        }),
      );
    }
    case "rsi_fade": {
      return attachMeta(
        "rsi_fade",
        rsiFadeStrategy({
          candles,
          period: Number(env.RSI_PERIOD || 14),
          overbought: Number(env.RSI_OVERBOUGHT ?? env.RSI_OB ?? 70),
          oversold: Number(env.RSI_OVERSOLD ?? env.RSI_OS ?? 30),
        }),
      );
    }
    case "volume_spike": {
      if (ctx.disableVolumeStrategies) return null;
      return attachMeta(
        "volume_spike",
        volumeSpikeStrategy({
          candles,
          lookback: Number(env.VOL_SPIKE_LOOKBACK || 20),
          mult: Number(env.VOL_SPIKE_MULT || 2),
        }),
      );
    }
    case "fakeout": {
      return attachMeta(
        "fakeout",
        fakeoutStrategy({
          candles,
          lookback: Number(env.FAKEOUT_LOOKBACK || 20),
          wickFrac: Number(env.FAKEOUT_WICK_FRAC || 0.6),
          minRangeFrac: Number(env.FAKEOUT_MIN_RANGE_FRAC || 0.004),
        }),
      );
    }
    case "wick_reversal": {
      return attachMeta(
        "wick_reversal",
        wickReversalStrategy({
          candles,
          lookback: Number(env.WICK_LOOKBACK || 20),
          minWickFrac: Number(env.WICK_MIN_WICK_FRAC || 0.6),
        }),
      );
    }
    default:
      return null;
  }
}

module.exports = {
  enabledStrategyIds,
  runStrategy,
  getStrategyMeta,
  STRATEGY_META,
};
