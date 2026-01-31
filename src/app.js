const express = require("express");
const { env } = require("./config");
const {
  getPipeline,
  getTickerStatus,
  getSubscribedTokens,
} = require("./kite/tickerManager");
const { isHalted, getHaltInfo, resetHalt } = require("./runtime/halt");
const { getDb } = require("./db");
const { telemetry } = require("./telemetry/signalTelemetry");
const { tradeTelemetry } = require("./telemetry/tradeTelemetry");
const { optimizer } = require("./optimizer/adaptiveOptimizer");
const { getLastFnoUniverse } = require("./fno/fnoUniverse");
const { costCalibrator } = require("./trading/costCalibrator");
const {
  describeRetention,
  ensureRetentionIndexes,
} = require("./market/retention");
const {
  getMarketCalendarMeta,
  reloadMarketCalendar,
} = require("./market/marketCalendar");
const { getRecentCandles } = require("./market/candleStore");
const { getQuoteGuardStats } = require("./kite/quoteGuard");
const { exchangeAndStoreKiteSession } = require("./kite/kiteLogin");
function buildAdminAuth() {
  const expected = env.ADMIN_API_KEY;

  // In production, we REQUIRE a key to avoid exposing kill switch, status, trades, etc.
  if (!expected && env.NODE_ENV === "production") {
    return (req, res) =>
      res
        .status(503)
        .json({ ok: false, error: "ADMIN_API_KEY not configured" });
  }

  // In dev, if key is not set, allow.
  if (!expected) {
    return (req, res, next) => next();
  }

  return (req, res, next) => {
    const xKey = req.header("x-api-key");
    const auth = req.header("authorization") || "";
    const bearer = auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : null;

    const provided = xKey || bearer;

    if (provided && provided === expected) return next();
    return res.status(401).json({ ok: false, error: "unauthorized" });
  };
}

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // ---- CORS (must be BEFORE /admin auth) ----
  app.use((req, res, next) => {
    const origin = env.CORS_ORIGIN || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key",
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS",
    );
    res.setHeader("Access-Control-Max-Age", "600");

    // Handle preflight
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  // ------------------------------------------

  app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

  // ---- Kite login redirect (request_token -> access_token) ----
  // Set your Kite app "redirect_url" to: http(s)://<host>:<port>/kite-redirect
  app.get("/kite-redirect", async (req, res) => {
    const requestToken = req.query.request_token;

    if (!requestToken) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing request_token" });
    }

    try {
      await exchangeAndStoreKiteSession({
        requestToken,
        source: "kite-redirect",
      });

      if (env.KITE_REDIRECT_SUCCESS_URL) {
        return res.redirect(String(env.KITE_REDIRECT_SUCCESS_URL));
      }

      return res.send("✅ Login successful, session created.");
    } catch (e) {
      return res
        .status(500)
        .json({ ok: false, error: e?.message || "Login failed" });
    }
  });

  // Protect ALL /admin/* endpoints
  app.use("/admin", buildAdminAuth());

  // Optional: FE can exchange request_token (if your Kite redirect_url points to FE).
  // In production, this endpoint is protected by ADMIN_API_KEY (same as other /admin routes).
  app.post("/admin/kite/session", async (req, res) => {
    const requestToken = req.body?.request_token;
    if (!requestToken) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing request_token" });
    }

    try {
      const session = await exchangeAndStoreKiteSession({
        requestToken,
        source: "admin-kite-session",
      });
      return res.json({
        ok: true,
        user_id: session?.user_id || null,
        api_key: session?.api_key || null,
      });
    } catch (e) {
      return res
        .status(500)
        .json({ ok: false, error: e?.message || "Login failed" });
    }
  });

  app.get("/admin/config", (req, res) => {
    res.json({
      tradingEnabled: env.TRADING_ENABLED,
      tokensCollection: env.TOKENS_COLLECTION,
      tokenFilters: {
        user_id: env.TOKEN_FILTER_USER_ID || null,
        api_key: env.TOKEN_FILTER_API_KEY || null,
        tokenField: env.TOKEN_FIELD || null,
      },
      subscribeTokens: env.SUBSCRIBE_TOKENS || "",
      subscribeSymbols: env.SUBSCRIBE_SYMBOLS || "",
      candleIntervals: env.CANDLE_INTERVALS,
      strategyId: env.STRATEGY_ID,
      strategies: env.STRATEGIES,
      signalIntervals: env.SIGNAL_INTERVALS,
      reconcileIntervalSec: env.RECONCILE_INTERVAL_SEC,
    });
  });

  app.get("/ready", async (req, res) => {
    try {
      const pipeline = getPipeline();
      const ticker = getTickerStatus();
      const halted = isHalted();

      const ok = !!pipeline && ticker.connected && !halted;

      res.status(ok ? 200 : 503).json({
        ok,
        halted,
        haltInfo: getHaltInfo(),
        ticker,
        now: new Date().toISOString(),
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // PATCH-10: Critical health endpoint (for monitors / Render health checks)
  // Returns 200 when system is safe-to-trade, else 503 with concrete reasons.
  app.get("/admin/health/critical", async (req, res) => {
    try {
      const ticker = getTickerStatus();
      const halted = isHalted();
      const haltInfo = getHaltInfo();
      const quoteGuard = getQuoteGuardStats();

      let pipeline = null;
      try {
        pipeline = getPipeline();
      } catch {}

      const killSwitch = !!pipeline?.trader?.risk?.killSwitch;

      const checks = [];

      if (env.CRITICAL_HEALTH_REQUIRE_TICKER_CONNECTED && !ticker?.connected) {
        checks.push({ ok: false, code: "TICKER_NOT_CONNECTED" });
      } else {
        checks.push({ ok: true, code: "TICKER_CONNECTED" });
      }

      if (env.CRITICAL_HEALTH_FAIL_ON_HALT && halted) {
        checks.push({ ok: false, code: "HALTED", meta: haltInfo || null });
      } else {
        checks.push({ ok: true, code: "NOT_HALTED" });
      }

      if (env.CRITICAL_HEALTH_FAIL_ON_KILL_SWITCH && killSwitch) {
        checks.push({ ok: false, code: "KILL_SWITCH" });
      } else {
        checks.push({ ok: true, code: "KILL_SWITCH_OFF" });
      }

      const breakerUntil = Number(quoteGuard?.breakerOpenUntil || 0);
      const breakerOpen = breakerUntil > Date.now();
      if (env.CRITICAL_HEALTH_FAIL_ON_QUOTE_BREAKER && breakerOpen) {
        checks.push({
          ok: false,
          code: "QUOTE_BREAKER_OPEN",
          meta: {
            breakerOpenUntil: breakerUntil,
            failStreak: quoteGuard?.failStreak || 0,
            lastError: quoteGuard?.lastError || null,
          },
        });
      } else {
        checks.push({ ok: true, code: "QUOTE_BREAKER_OK" });
      }

      const deep = String(req.query.deep || "").trim() === "1";
      const pipeStatus = deep && pipeline ? await pipeline.status() : null;

      const ok = checks.every((c) => c.ok);

      res.status(ok ? 200 : 503).json({
        ok,
        now: new Date().toISOString(),
        checks,
        ticker,
        halted,
        haltInfo,
        killSwitch,
        quoteGuard,
        pipeline: pipeline ? { ok: true } : { ok: false },
        ...(pipeStatus ? { deepStatus: pipeStatus } : {}),
      });
    } catch (e) {
      res
        .status(503)
        .json({ ok: false, error: e.message, now: new Date().toISOString() });
    }
  });

  app.get("/admin/status", async (req, res) => {
    try {
      const pipeline = getPipeline();
      const s = await pipeline.status();
      const ticker = getTickerStatus();
      const halted = isHalted();

      res.json({
        ok: true,
        ...s,
        halted,
        haltInfo: getHaltInfo(),
        ticker,
        now: new Date().toISOString(),
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // Market calendar diagnostics
  app.get("/admin/market/calendar", (req, res) => {
    try {
      const meta = getMarketCalendarMeta();
      res.json({ ok: true, meta });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post("/admin/market/calendar/reload", async (req, res) => {
    try {
      const meta = await reloadMarketCalendar();
      res.json({ ok: true, meta });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // PATCH-6: Cost calibration snapshot + recent reconciliation runs
  app.get("/admin/cost/calibration", async (req, res) => {
    try {
      const snap = costCalibrator.snapshot();
      const recent = await costCalibrator.recentRuns(10);
      res.json({ ok: true, calibration: snap, recentRuns: recent });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post("/admin/cost/calibration/reload", async (req, res) => {
    try {
      const r = await costCalibrator.reloadFromDb();
      res.json({ ok: true, result: r, calibration: costCalibrator.snapshot() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get("/admin/subscriptions", (req, res) => {
    try {
      const tokens = getSubscribedTokens ? getSubscribedTokens() : [];
      res.json({ ok: true, count: tokens.length, tokens });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // FE: recent candles for chart
  // GET /admin/candles/recent?token=123&intervalMin=1&limit=300
  app.get("/admin/candles/recent", async (req, res) => {
    try {
      const token = Number(req.query.token);
      const intervalMin = Number(
        req.query.intervalMin || req.query.interval || 1,
      );

      const limitRaw = Number(req.query.limit || 300);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(2000, Math.max(10, limitRaw))
        : 300;

      if (!Number.isFinite(token) || token <= 0) {
        return res.status(400).json({ ok: false, error: "invalid_token" });
      }

      const rows = await getRecentCandles(token, intervalMin, limit);

      return res.json({ ok: true, rows });
    } catch (e) {
      return res
        .status(503)
        .json({ ok: false, error: e?.message || String(e) });
    }
  });

  // PATCH-9: DB retention (TTL) visibility + manual ensure
  app.get("/admin/db/retention", async (req, res) => {
    try {
      const r = await describeRetention();
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post("/admin/db/retention/ensure", async (req, res) => {
    try {
      const out = await ensureRetentionIndexes({ log: true });
      const after = await describeRetention();
      res.json({ ok: true, result: out, after });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Derivatives universe snapshot (FUT or OPT underlying subscription)
  app.get("/admin/fno", (req, res) => {
    try {
      const u = getLastFnoUniverse();
      res.json(u || { ok: true, enabled: false, universe: null });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post("/admin/kill", async (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    try {
      await getPipeline().setKillSwitch(enabled, "ADMIN");
      res.json({ ok: true, kill: enabled });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // Reset runtime HALT (does NOT disable kill-switch). Useful after fixing a bad session/API error.
  app.post("/admin/halt/reset", async (req, res) => {
    try {
      resetHalt();
      res.json({ ok: true, halted: false, haltInfo: null });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  app.get("/admin/trades/recent", async (req, res) => {
    try {
      const limitRaw = Number(req.query.limit || 10);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(50, Math.max(1, limitRaw))
        : 10;

      const db = getDb();
      const rows = await db
        .collection("trades")
        .find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      res.json({ ok: true, rows });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // Telemetry endpoints (signal observability)
  app.get("/admin/telemetry/snapshot", (req, res) => {
    res.json({ ok: true, data: telemetry.snapshot() });
  });

  app.post("/admin/telemetry/flush", async (req, res) => {
    try {
      const out = await telemetry.flush();
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get("/admin/telemetry/daily", async (req, res) => {
    try {
      const dk = req.query.dayKey;
      const doc = await telemetry.readDailyFromDb(dk);
      res.json({ ok: !!doc, dayKey: dk || telemetry.snapshot().dayKey, doc });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Trade telemetry endpoints (fee-multiple + pnl vs costs)
  app.get("/admin/trade-telemetry/snapshot", (req, res) => {
    res.json({ ok: true, data: tradeTelemetry.snapshot() });
  });

  app.post("/admin/trade-telemetry/flush", async (req, res) => {
    try {
      const out = await tradeTelemetry.flush();
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get("/admin/trade-telemetry/daily", async (req, res) => {
    try {
      const dk = req.query.dayKey;
      const doc = await tradeTelemetry.readDailyFromDb(dk);
      res.json({
        ok: !!doc,
        dayKey: dk || tradeTelemetry.snapshot().dayKey,
        doc,
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Adaptive optimizer endpoints (fee-multiple tuning)
  app.get("/admin/optimizer/snapshot", (req, res) => {
    try {
      res.json({ ok: true, data: optimizer.snapshot() });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Alias for convenience (dashboards often expect /admin/optimizer)
  app.get("/admin/optimizer", (req, res) => {
    try {
      res.json({ ok: true, data: optimizer.snapshot() });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Force persistence flush (DB-persisted optimizer state)
  app.post("/admin/optimizer/flush", async (req, res) => {
    try {
      const out = await optimizer.flushState({ force: true });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post("/admin/optimizer/reload", async (req, res) => {
    try {
      const out = await optimizer.reloadFromDb();
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post("/admin/optimizer/reset", (req, res) => {
    try {
      optimizer.reset();
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Rejection histograms (symbol×strategy×timeBucket) for tuning
  app.get("/admin/rejections", async (req, res) => {
    try {
      const top = Number(req.query.top) || undefined;
      const dk = req.query.dayKey;

      if (dk) {
        const doc = await telemetry.readDailyFromDb(dk);
        if (!doc) {
          res
            .status(404)
            .json({ ok: false, error: "day_not_found", dayKey: dk });
          return;
        }

        const bySymbol = Object.entries(doc.blockedBySymbol || {})
          .map(([key, v]) => ({ key, count: Number(v) || 0 }))
          .sort((a, b) => b.count - a.count)
          .slice(0, Math.min(Number(top) || 50, 50));

        const flat = [];
        const tree = doc.blockedBySymbolStrategyBucketReason || {};
        for (const sym of Object.keys(tree)) {
          const byStrat = tree[sym] || {};
          for (const strat of Object.keys(byStrat)) {
            const byBucket = byStrat[strat] || {};
            for (const bucket of Object.keys(byBucket)) {
              const byKey = byBucket[bucket] || {};
              for (const rk of Object.keys(byKey)) {
                flat.push({
                  symbol: sym,
                  strategyId: strat,
                  bucket,
                  reasonKey: rk,
                  count: Number(byKey[rk]) || 0,
                });
              }
            }
          }
        }
        flat.sort((a, b) => b.count - a.count);

        res.json({
          ok: true,
          source: "db",
          dayKey: doc.dayKey,
          tz: doc.tz,
          updatedAt: doc.updatedAt || null,
          blockedTotal: doc.blockedTotal || 0,
          top: {
            bySymbol,
            bySymbolStrategyBucketReason: flat.slice(0, Number(top) || 200),
          },
        });
        return;
      }

      res.json({
        ok: true,
        source: "memory",
        data: telemetry.rejectionsSnapshot({ top }),
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  return app;
}

module.exports = { buildApp };
