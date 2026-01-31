const { env } = require("./config");
const { DateTime } = require("luxon");
const {
  getSessionForDateTime,
  buildBoundsForToday,
} = require("./market/marketCalendar");
const { logger } = require("./logger");
const { CandleBuilder } = require("./market/candleBuilder");
const { ensureIndexes, upsertCandle } = require("./market/candleStore");
const { backfillCandles } = require("./market/backfill");
const { evaluateOnCandleClose } = require("./strategy/strategyEngine");
const { RiskEngine } = require("./risk/riskEngine");
const { TradeManager } = require("./trading/tradeManager");
const { telemetry } = require("./telemetry/signalTelemetry");

function buildPipeline({ kite, tickerCtrl }) {
  const intervals = (env.CANDLE_INTERVALS || "1,3")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const candleBuilder = new CandleBuilder({
    intervalsMinutes: intervals,
    timezone: env.CANDLE_TZ,
  });

  const risk = new RiskEngine();
  const trader = new TradeManager({ kite, riskEngine: risk });

  let tokensRef = [];
  let tokensSet = new Set();
  // In OPT mode we may subscribe option tokens at runtime for execution/exits.
  // Strategy evaluation must stay limited to the original underlying universe.
  let signalTokensSet = new Set();

  // Separate queue for runtime subscription/backfills (avoid deadlocks with main serial queue)
  let subsSerial = Promise.resolve();
  function enqueueSubs(fn, label) {
    subsSerial = subsSerial.then(fn).catch((e) => {
      logger.warn(
        { e: e?.message || String(e), label },
        "[pipeline] subscription task failed",
      );
    });
    return subsSerial;
  }

  // ---- SERIAL QUEUE (prevents tick/order/reconcile overlap) ----
  let serial = Promise.resolve();

  function enqueue(fn, label) {
    serial = serial.then(fn).catch((e) => {
      logger.warn(
        { e: e?.message || String(e), label },
        "[pipeline] task failed",
      );
    });
    return serial;
  }

  async function initForTokens(tokens) {
    tokensRef = Array.isArray(tokens) ? tokens : [];
    tokensSet = new Set(
      tokensRef
        .map((t) => Number(t))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
    // Freeze the initial universe as "signal tokens".
    // Runtime-added tokens (options) should not generate strategy signals.
    signalTokensSet = new Set(tokensSet);
    await trader.init();

    for (const intervalMin of intervals) await ensureIndexes(intervalMin);

    for (const token of tokensRef) {
      for (const intervalMin of intervals) {
        try {
          await backfillCandles({
            kite,
            instrument_token: token,
            intervalMin,
            timezone: env.CANDLE_TZ,
          });
          logger.info({ token, intervalMin }, "[backfill] ok");
        } catch (e) {
          logger.warn(
            { token, intervalMin, e: e.message },
            "[backfill] failed",
          );
        }
      }
    }
  }

  // Allow seeding subscription view (primarily for admin visibility)
  function setSubscribedTokens(tokens) {
    tokensRef = Array.isArray(tokens) ? tokens : [];
    tokensSet = new Set(
      tokensRef
        .map((t) => Number(t))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
  }

  // Runtime subscribe for OPT mode: subscribe chosen option token & optionally backfill candles.
  async function addTokens(tokens, opts = {}) {
    const enabled = String(env.RUNTIME_SUBSCRIBE_ENABLED || "true") === "true";
    if (!enabled) return { ok: false, error: "runtime_subscribe_disabled" };

    const arr = (tokens || [])
      .map((t) => Number(t))
      .filter((n) => Number.isFinite(n) && n > 0);
    const uniq = Array.from(new Set(arr));
    const toAdd = uniq.filter((t) => !tokensSet.has(t));
    if (!toAdd.length) {
      return { ok: true, added: [], tokens: Array.from(tokensSet) };
    }

    if (!tickerCtrl || typeof tickerCtrl.subscribe !== "function") {
      return { ok: false, error: "tickerCtrl_not_available" };
    }

    // Serialize subscribe operations (separate queue from tick processing)
    const res = await enqueueSubs(async () => {
      const sub = await tickerCtrl.subscribe(toAdd);
      if (!sub?.ok) return sub;

      for (const t of toAdd) tokensSet.add(t);
      tokensRef = Array.from(tokensSet);

      // Kick off backfill in background (do not block entry)
      const doBackfill =
        String(env.RUNTIME_SUBSCRIBE_BACKFILL || "true") === "true" &&
        opts.backfill !== false;

      if (doBackfill) {
        const daysOverride = Number(
          opts.daysOverride || env.RUNTIME_SUBSCRIBE_BACKFILL_DAYS || 1,
        );
        void enqueueSubs(async () => {
          for (const token of toAdd) {
            for (const intervalMin of intervals) {
              try {
                await backfillCandles({
                  kite,
                  instrument_token: token,
                  intervalMin,
                  timezone: env.CANDLE_TZ,
                  daysOverride,
                });
                logger.info({ token, intervalMin }, "[runtime-backfill] ok");
              } catch (e) {
                logger.warn(
                  { token, intervalMin, e: e?.message || String(e) },
                  "[runtime-backfill] failed",
                );
              }
            }
          }
        }, "runtimeBackfill");
      }

      return { ok: true, added: toAdd, tokens: Array.from(tokensSet) };
    }, "runtimeSubscribe");

    return res;
  }

  function subscriptions() {
    return {
      ok: true,
      tokens: Array.from(tokensSet).sort((a, b) => a - b),
      count: tokensSet.size,
    };
  }

  // Provide runtime token adder to the trader (needed for OPT mode correctness)
  if (typeof trader.setRuntimeAddTokens === "function") {
    trader.setRuntimeAddTokens(addTokens);
  }

  async function reconcile() {
    return enqueue(async () => {
      await trader.reconcile(tokensRef);
      logger.info("[reconcile] done");
    }, "reconcile");
  }

  async function handleClosedCandles(closed) {
    for (const c of closed || []) {
      // ---- Market session guard (PIPELINE-side) ----
      // Stop generating signals (and persisting out-of-session bars) after market close.
      // Gate using the candle's *close time* (bucket start + interval) rather than "now".
      // This prevents post-close ticks from creating extra candles like 15:30–15:33, 15:33–15:36, etc.
      if (!isCandleWithinMarketSession(c)) {
        continue;
      }

      await upsertCandle(c);

      // IMPORTANT (OPT mode correctness):
      // We may subscribe option tokens at runtime for execution/exits,
      // but we must NOT generate strategy signals on option tokens.
      // Only evaluate strategies on the original underlying universe.
      const tok = Number(c.instrument_token);
      if (
        Number.isFinite(tok) &&
        signalTokensSet.size &&
        !signalTokensSet.has(tok)
      ) {
        continue;
      }

      const signal = await evaluateOnCandleClose({
        instrument_token: c.instrument_token,
        intervalMin: c.interval_min,
      });

      if (signal) {
        logger.info(
          {
            token: signal.instrument_token,
            side: signal.side,
            reason: signal.reason,
            strategyId: signal.strategyId,
            confidence: signal.confidence,
            regime: signal.regime,
          },
          "[signal]",
        );
        telemetry.recordDecision({
          signal,
          token: signal.instrument_token,
          outcome: "DISPATCHED",
          stage: "pipeline",
          reason: signal.reason,
          meta: { confidence: signal.confidence, regime: signal.regime },
        });
        await trader.onSignal(signal);
      }
    }
  }

  function isWithinMarketHours(now = new Date()) {
    const tz = env.CANDLE_TZ || "Asia/Kolkata";
    const dt = DateTime.fromJSDate(now, { zone: tz });

    const session = getSessionForDateTime(dt, {
      marketOpen: env.MARKET_OPEN,
      marketClose: env.MARKET_CLOSE,
      stopNewEntriesAfter: env.STOP_NEW_ENTRIES_AFTER,
    });

    if (!session.allowTradingDay) return false;

    const { open, close } = buildBoundsForToday(session, dt);

    if (!open.isValid || !close.isValid) return true;
    return dt >= open && dt <= close;
  }

  function isCandleWithinMarketSession(candle) {
    if (!candle || !candle.ts) return true;

    const tz = env.CANDLE_TZ || "Asia/Kolkata";
    const start = DateTime.fromJSDate(candle.ts, { zone: tz });
    const intervalMin = Number(candle.interval_min || 0);
    const closeTs = start.plus({ minutes: Math.max(1, intervalMin) });

    const session = getSessionForDateTime(closeTs, {
      marketOpen: env.MARKET_OPEN,
      marketClose: env.MARKET_CLOSE,
      stopNewEntriesAfter: env.STOP_NEW_ENTRIES_AFTER,
    });

    // Drop candles on weekends/holidays unless a special session explicitly allows trading.
    if (!session.allowTradingDay) return false;

    const { open, close } = buildBoundsForToday(session, closeTs);

    if (!open.isValid || !close.isValid) return true;
    return closeTs >= open && closeTs <= close;
  }
  async function processTicksOnce(ticks) {
    // tick->trader (LTP updates + throttled risk checks)
    for (const t of ticks || []) {
      try {
        await Promise.resolve(trader.onTick(t));
      } catch (e) {
        logger.warn({ e: e?.message || String(e) }, "[trader] onTick failed");
      }
    }

    // tick->candles
    // IMPORTANT: still allow trader.onTick() for all ticks, but only build candles from in-session ticks.
    // This prevents post-close ticks from producing after-hours candles and signals.
    const candleTicks = (ticks || []).filter((t) => {
      try {
        const ts = t?.exchange_timestamp
          ? new Date(t.exchange_timestamp)
          : t?.last_trade_time
            ? new Date(t.last_trade_time)
            : new Date();
        return isWithinMarketHours(ts);
      } catch {
        return false;
      }
    });

    const closed = candleBuilder.onTicks(candleTicks);
    await handleClosedCandles(closed);
  }

  async function onTicks(ticks) {
    // serialize processing to avoid overlap
    return enqueue(() => processTicksOnce(ticks), "onTicks");
  }

  async function onOrderUpdate(order) {
    return enqueue(async () => {
      await trader.onOrderUpdate(order);
    }, "onOrderUpdate");
  }

  async function setKillSwitch(enabled, reason) {
    // Persist kill-switch in DB via TradeManager so it survives restarts.
    if (typeof trader.setKillSwitch === "function") {
      await trader.setKillSwitch(!!enabled, reason || "ADMIN");
    } else {
      risk.setKillSwitch(!!enabled);
    }
  }

  async function status() {
    return trader.status();
  }

  async function candleFinalizerTick() {
    if (String(env.CANDLE_TIMER_FINALIZER_ENABLED || "true") !== "true") return;
    if (!isWithinMarketHours(new Date())) return;

    const closed = candleBuilder.finalizeDue(new Date(), {
      graceMs: Number(env.CANDLE_FINALIZE_GRACE_MS || 1500),
      maxBars: Number(env.CANDLE_FINALIZE_MAX_BARS_PER_RUN || 3),
    });

    if (closed.length) {
      await handleClosedCandles(closed);
    }
  }

  if (String(env.CANDLE_TIMER_FINALIZER_ENABLED || "true") === "true") {
    const everyMs = Number(env.CANDLE_FINALIZER_INTERVAL_MS || 1000);
    setInterval(() => {
      enqueue(() => candleFinalizerTick(), "candleFinalizer").catch(() => {});
    }, everyMs);
  }
  return {
    initForTokens,
    setSubscribedTokens,
    addTokens,
    subscriptions,
    onTicks,
    onOrderUpdate,
    reconcile,
    setKillSwitch,
    status,
    trader,
  };
}

module.exports = { buildPipeline };
