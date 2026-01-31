const { env, subscribeTokens, subscribeSymbols } = require("../config");
const {
  resolveSubscribeTokens,
  ensureInstrument,
} = require("../instruments/instrumentRepo");
const { buildFnoUniverse, getLastFnoUniverse } = require("../fno/fnoUniverse");
const { logger } = require("../logger");
const { alert } = require("../alerts/alertService");
const { isHalted } = require("../runtime/halt");
const { createTicker, createKiteConnect } = require("./kiteClients");
const { buildPipeline } = require("../pipeline");

let kite = null;
let ticker = null;

let currentToken = null;
let pipeline = null;
let tickerConnected = false;
let lastDisconnect = null;

// Tick batching (prevents overlapping async handlers)
let tickQueue = [];
let draining = false;

let reconcileTimer = null;

// Track ALL subscribed tokens (base universe + runtime position tokens)
let subscribedTokens = new Set();
let _lastPosResubAt = 0;
let _lastUniverseRebuildAt = 0;

function _bool(v, def = false) {
  if (v === undefined || v === null) return def;
  return String(v).toLowerCase() === "true";
}

function _num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function _isResubEnabled() {
  return _bool(env.POSITION_RESUBSCRIBE_ENABLED, true);
}

function _isResubOnReconnect() {
  return _bool(env.POSITION_RESUBSCRIBE_ON_RECONNECT, true);
}

function _wantUnderlying() {
  return _bool(env.POSITION_RESUBSCRIBE_UNDERLYING, true);
}

// IMPORTANT: product filtering is dangerous for recovery (can silently skip true open positions).
// Keep it OFF by default; enable only if you REALLY want it.
function _respectProductStrict() {
  // Accept both names (config drift/back-compat)
  return (
    _bool(env.POSITION_RESUBSCRIBE_RESPECT_PRODUCT, false) ||
    _bool(env.POSITION_RESUBSCRIBE_PRODUCT_STRICT, false)
  );
}

function _isOptLikeInstrument(doc) {
  const seg = String(doc?.segment || "").toUpperCase();
  const it = String(doc?.instrument_type || "").toUpperCase();
  return seg.includes("-OPT") || it === "CE" || it === "PE" || it === "OPT";
}

async function _getActiveNetPositionsSafe() {
  try {
    const positions = await kite.getPositions();
    const net = positions?.net || positions?.day || [];
    return Array.isArray(net) ? net : [];
  } catch (e) {
    logger.warn(
      { e: e?.message || String(e) },
      "[pos-resub] getPositions failed",
    );
    return [];
  }
}

async function _maybeRebuildUniverse() {
  const coolSec = _num(
    env.POSITION_RESUBSCRIBE_UNDERLYING_REBUILD_COOLDOWN_SEC,
    300,
  );
  const now = Date.now();
  if (now - _lastUniverseRebuildAt < coolSec * 1000) return false;
  _lastUniverseRebuildAt = now;
  try {
    await buildFnoUniverse({ kite });
    return true;
  } catch {
    return false;
  }
}

async function _positionSubscriptionTokens() {
  const net = await _getActiveNetPositionsSafe();

  const out = new Set();
  const wantUnderlying = _wantUnderlying();
  const uni = getLastFnoUniverse()?.universe || null;

  for (const p of net) {
    const tok = Number(p?.instrument_token);
    if (!Number.isFinite(tok) || tok <= 0) continue;

    const qty = Number(p?.quantity ?? p?.net_quantity ?? 0);
    if (!Number.isFinite(qty) || qty === 0) continue;

    // Optional strict product gate (OFF by default)
    if (_respectProductStrict()) {
      const product = p?.product ? String(p.product) : null;
      if (
        product &&
        env.DEFAULT_PRODUCT &&
        product !== String(env.DEFAULT_PRODUCT)
      ) {
        continue;
      }
    }

    out.add(tok);

    // For option positions, also subscribe the underlying token (best-effort via FNO universe)
    if (wantUnderlying && _bool(env.FNO_ENABLED, false)) {
      try {
        const doc = await ensureInstrument(kite, tok);
        if (_isOptLikeInstrument(doc)) {
          const underlying = String(doc?.name || "")
            .toUpperCase()
            .trim();

          let underTok = Number(uni?.contracts?.[underlying]?.instrument_token);
          if (Number.isFinite(underTok) && underTok > 0) {
            out.add(underTok);
            continue;
          }

          // Try a throttled rebuild if missing
          const rebuilt = await _maybeRebuildUniverse();
          if (rebuilt) {
            const uni2 = getLastFnoUniverse()?.universe || null;
            underTok = Number(uni2?.contracts?.[underlying]?.instrument_token);
            if (Number.isFinite(underTok) && underTok > 0) out.add(underTok);
          }
        }
      } catch (e) {
        logger.warn(
          { tok, e: e?.message || String(e) },
          "[pos-resub] ensureInstrument failed",
        );
      }
    }
  }

  return Array.from(out);
}

async function _subscribeTokens(tokens) {
  const arr = (tokens || [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!arr.length) return { ok: true, added: [] };
  ticker.subscribe(arr);
  ticker.setMode(ticker.modeFull, arr);

  for (const t of arr) subscribedTokens.add(t);
  return { ok: true, added: arr };
}

async function ensureActivePositionSubscriptions({
  force = false,
  reason = "periodic",
} = {}) {
  if (!kite || !ticker || !pipeline)
    return { ok: false, added: [], skipped: true };
  if (!_isResubEnabled()) return { ok: true, added: [], skipped: true };

  const minSec = _num(env.POSITION_RESUBSCRIBE_MIN_INTERVAL_SEC, 30);
  const now = Date.now();
  if (!force && minSec > 0 && now - _lastPosResubAt < minSec * 1000) {
    return { ok: true, added: [], throttled: true };
  }
  _lastPosResubAt = now;

  const posTokens = await _positionSubscriptionTokens().catch(() => []);
  const missing = posTokens.filter((t) => !subscribedTokens.has(Number(t)));

  if (!missing.length) return { ok: true, added: [] };

  await _subscribeTokens(missing);

  // If pipeline supports addTokens, let it backfill candles for exits/indicators.
  if (pipeline && typeof pipeline.addTokens === "function") {
    try {
      await pipeline.addTokens(missing, { backfill: true, reason });
    } catch (e) {
      logger.warn(
        { e: e?.message || String(e), missing, reason },
        "[pos-resub] pipeline.addTokens failed",
      );
    }
  }

  logger.info(
    { added: missing, reason },
    "[pos-resub] subscribed missing position tokens",
  );
  return { ok: true, added: missing };
}

function stopReconcileLoop() {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

function startReconcileLoop() {
  stopReconcileLoop();
  const sec = _num(env.RECONCILE_INTERVAL_SEC, 60);
  if (!Number.isFinite(sec) || sec <= 0) return;

  reconcileTimer = setInterval(() => {
    if (!pipeline) return;
    if (!tickerConnected) return;

    // Ensure we are subscribed to any broker-side open positions (restart/recovery safety)
    void ensureActivePositionSubscriptions({ reason: "periodic" }).catch(
      () => {},
    );

    pipeline
      .reconcile()
      .catch((e) =>
        logger.warn(
          { e: e?.message || String(e) },
          "[reconcile] periodic failed",
        ),
      );
  }, sec * 1000);
}

async function drainTicks() {
  if (draining) return;
  draining = true;
  try {
    while (tickQueue.length) {
      // merge all queued batches into one
      const merged = [];
      for (const batch of tickQueue) {
        if (Array.isArray(batch) && batch.length) merged.push(...batch);
      }
      tickQueue = [];

      if (!pipeline) continue;
      if (isHalted()) continue; // optional: reduce compute when halted

      await pipeline.onTicks(merged);
    }
  } finally {
    draining = false;
  }
}

async function setSession(accessToken) {
  if (accessToken === currentToken) return;

  logger.info("[kite] session update detected");

  stopReconcileLoop();

  if (ticker) {
    try {
      ticker.disconnect();
    } catch {}
    ticker = null;
    tickerConnected = false;
  }

  kite = createKiteConnect({ apiKey: env.KITE_API_KEY, accessToken });
  ticker = createTicker({ apiKey: env.KITE_API_KEY, accessToken });
  pipeline = buildPipeline({
    kite,
    tickerCtrl: { subscribe: _subscribeTokens },
  });

  subscribedTokens = new Set();
  _lastPosResubAt = 0;
  _lastUniverseRebuildAt = 0;

  wireEvents();
  ticker.connect();

  currentToken = accessToken;
}

function wireEvents() {
  ticker.on("connect", async () => {
    tickerConnected = true;
    lastDisconnect = null;

    logger.info("[kite] ticker connected");

    try {
      let tokensIn = subscribeTokens;
      let symbolsIn = subscribeSymbols;

      // F&O mode: dynamically build derivative universe (futures or underlying tokens for options)
      if (_bool(env.FNO_ENABLED, false)) {
        try {
          const uni = await buildFnoUniverse({ kite });
          const u = uni?.universe;
          if (u?.tokens?.length) {
            const merge = _bool(env.FNO_MERGE_CASH_UNIVERSE, false);
            tokensIn = merge
              ? Array.from(new Set([...(tokensIn || []), ...u.tokens]))
              : u.tokens;
            symbolsIn = merge ? symbolsIn : [];
            logger.info(
              {
                mode: u.mode,
                underlyings: u.underlyings,
                tokens: u.tokens,
                symbols: u.symbols,
              },
              "[fno] universe active",
            );
          }
        } catch (e) {
          logger.error(
            { e: e?.message || String(e) },
            "[fno] universe build failed",
          );
        }
      }

      const resolved = await resolveSubscribeTokens(kite, {
        tokens: tokensIn,
        symbols: symbolsIn,
      });

      // PATCH-3: Recovery safety — also subscribe any broker-side open positions (option tokens etc.)
      const posTokens = await _positionSubscriptionTokens().catch(() => []);
      const allTokens = Array.from(
        new Set([...(resolved || []), ...(posTokens || [])]),
      );

      if (allTokens.length) {
        ticker.subscribe(allTokens);
        ticker.setMode(ticker.modeFull, allTokens);
        subscribedTokens = new Set(allTokens);

        logger.info(
          {
            subscribeTokens: allTokens,
            fromSymbols: subscribeSymbols,
            posTokensAdded: (posTokens || []).length,
          },
          "[kite] subscribed",
        );

        await pipeline.initForTokens(allTokens);
        await pipeline.reconcile();

        // One more pass to catch any late-reported positions right after connect
        await ensureActivePositionSubscriptions({
          force: true,
          reason: "connect",
        });

        startReconcileLoop();
      } else {
        logger.warn(
          { subscribeTokens, subscribeSymbols },
          "[kite] nothing to subscribe (set SUBSCRIBE_SYMBOLS or SUBSCRIBE_TOKENS)",
        );
      }
    } catch (e) {
      tickerConnected = false;
      stopReconcileLoop();
      logger.error(
        { e: e?.message || String(e) },
        "[kite] connect handler failed",
      );
      alert("error", "❌ Kite connect handler failed", {
        message: e?.message || String(e),
      }).catch(() => {});
    }
  });

  ticker.on("ticks", (ticks) => {
    try {
      if (!pipeline) return;

      tickQueue.push(ticks || []);

      // safety: if something goes crazy, keep queue bounded
      const max = _num(env.TICK_QUEUE_MAX, 50);
      if (Number.isFinite(max) && max > 0 && tickQueue.length > max) {
        tickQueue = tickQueue.slice(-max);
      }

      void drainTicks().catch((e) =>
        logger.error({ err: e?.message || e }, "[kite] tick drain failed"),
      );
    } catch (e) {
      logger.warn(
        { e: e?.message || String(e) },
        "[pipeline] ticks enqueue error",
      );
    }
  });

  ticker.on("order_update", (order) => {
    logger.info(
      {
        order_id: order.order_id,
        status: order.status,
        status_message: order.status_message,
        status_message_raw: order.status_message_raw,
      },
      "[ticker] order_update",
    );

    if (!pipeline?.onOrderUpdate) {
      logger.warn("[ticker] order_update ignored (pipeline not ready)");
      return;
    }

    pipeline.onOrderUpdate(order).catch((e) => {
      logger.error({ e: e.message }, "[order_update] handler failed");
    });
  });

  ticker.on("error", (err) => {
    logger.warn({ err }, "[kite] ticker error");
    alert("warn", "⚠️ Kite ticker error", {
      err: String(err?.message || err),
    }).catch(() => {});
  });

  ticker.on("reconnect", () => {
    if (!_isResubOnReconnect()) return;
    try {
      const arr = Array.from(subscribedTokens || []);
      if (arr.length) {
        ticker.subscribe(arr);
        ticker.setMode(ticker.modeFull, arr);
        logger.warn(
          { count: arr.length },
          "[kite] reconnect: re-subscribed tokens",
        );
      }
    } catch (e) {
      logger.warn(
        { e: e?.message || String(e) },
        "[kite] reconnect resubscribe failed",
      );
    }

    void ensureActivePositionSubscriptions({
      force: true,
      reason: "reconnect",
    }).catch(() => {});
  });

  ticker.on("close", () => {
    tickerConnected = false;
    lastDisconnect = new Date().toISOString();
    stopReconcileLoop();
    logger.warn("[kite] ticker closed");
    alert("warn", "⚠️ Kite ticker closed").catch(() => {});
  });

  ticker.on("disconnect", (err) => {
    tickerConnected = false;
    lastDisconnect = new Date().toISOString();
    stopReconcileLoop();
    logger.warn({ err }, "[kite] ticker disconnected");
    alert("warn", "⚠️ Kite ticker disconnected", {
      err: String(err?.message || err),
    }).catch(() => {});
  });
}

function getPipeline() {
  if (!pipeline) throw new Error("Pipeline not ready yet");
  return pipeline;
}

function getTickerStatus() {
  return {
    connected: tickerConnected,
    lastDisconnect,
    hasSession: !!currentToken,
  };
}

function getSubscribedTokens() {
  return Array.from(subscribedTokens || []);
}

module.exports = {
  setSession,
  getPipeline,
  getTickerStatus,
  getSubscribedTokens,
  ensureActivePositionSubscriptions,
};
