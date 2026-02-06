const express = require("express");
const { env } = require("./config");
const {
  getPipeline,
  getTickerStatus,
  getSubscribedTokens,
} = require("./kite/tickerManager");
const { isHalted, getHaltInfo, resetHalt } = require("./runtime/halt");
const {
  getTradingEnabled,
  getTradingEnabledSource,
  setTradingEnabled,
} = require("./runtime/tradingEnabled");
const { getDb } = require("./db");
const { telemetry } = require("./telemetry/signalTelemetry");
const { tradeTelemetry } = require("./telemetry/tradeTelemetry");
const { optimizer } = require("./optimizer/adaptiveOptimizer");
const { getLastFnoUniverse } = require("./fno/fnoUniverse");
const { costCalibrator } = require("./trading/costCalibrator");
const { equityService } = require("./account/equityService");
const { buildPositionsSnapshot } = require("./trading/positionService");
const {
  getOrdersSnapshot,
  getOrderHistory,
  getOrderLogsSnapshot,
} = require("./trading/orderService");
const { getRiskLimits, setRiskLimits } = require("./risk/riskLimits");
const { getStrategyKpis } = require("./telemetry/strategyKpi");
const { getExecutionQuality } = require("./execution/executionStats");
const { marketHealth } = require("./market/marketHealth");
const { recordAudit, listAuditLogs } = require("./audit/auditLog");
const {
  listChannels,
  addChannel,
  removeChannel,
  listIncidents,
  emitNotification,
} = require("./alerts/notificationCenter");
const { buildRbac } = require("./security/rbac");
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

function normalizeActiveTrade(activeTrade) {
  if (!activeTrade) return null;
  const instrument = activeTrade.instrument || {};
  const instrument_token =
    activeTrade.instrument_token ??
    activeTrade.instrumentToken ??
    instrument.instrument_token ??
    null;
  const tradingsymbol =
    instrument.tradingsymbol ??
    activeTrade.tradingsymbol ??
    activeTrade.symbol ??
    null;
  const timeStopAt =
    activeTrade.timeStopAt ??
    activeTrade.timeStopAtMs ??
    activeTrade.timeStopAtTs ??
    activeTrade.timeStopAtIso ??
    activeTrade.timeStopMs ??
    null;

  return {
    ...activeTrade,
    instrument_token,
    instrument: {
      ...instrument,
      tradingsymbol,
    },
    side: activeTrade.side ?? activeTrade.transaction_type ?? null,
    entryPrice: activeTrade.entryPrice ?? activeTrade.entry_price ?? null,
    stopLoss: activeTrade.stopLoss ?? activeTrade.stop_loss ?? null,
    targetPrice: activeTrade.targetPrice ?? activeTrade.target_price ?? null,
    slTrigger: activeTrade.slTrigger ?? activeTrade.sl_trigger ?? null,
    minGreenInr: activeTrade.minGreenInr ?? activeTrade.min_green_inr ?? null,
    minGreenPts: activeTrade.minGreenPts ?? activeTrade.min_green_pts ?? null,
    beLocked: activeTrade.beLocked ?? activeTrade.be_locked ?? null,
    peakLtp: activeTrade.peakLtp ?? activeTrade.peak_ltp ?? null,
    trailSl: activeTrade.trailSl ?? activeTrade.trail_sl ?? null,
    timeStopAt,
  };
}

function normalizeTradeRow(row) {
  if (!row) return row;
  const instrument = row.instrument || {};
  const instrument_token =
    row.instrument_token ?? row.instrumentToken ?? instrument.instrument_token ?? null;
  const tradingsymbol =
    instrument.tradingsymbol ?? row.tradingsymbol ?? row.symbol ?? null;
  const exchange = instrument.exchange ?? row.exchange ?? null;
  const segment = instrument.segment ?? row.segment ?? null;
  const regimeValue =
    row.regime ?? row.marketRegime ?? row.regimeLabel ?? row.regime_state ?? null;
  const premiumValue =
    row.premium ?? row.entryPremium ?? row.entry_premium ?? null;
  const entrySlippageValue =
    row.entrySlippage ?? row.slippageEntry ?? row.slippage_entry ?? null;
  const exitSlippageValue =
    row.exitSlippage ?? row.slippageExit ?? row.slippage_exit ?? null;
  const totalSlippageValue =
    row.slippage ??
    row.totalSlippage ??
    row.slippageTotal ??
    null;
  const entrySpreadValue =
    row.entrySpread ?? row.spreadAtEntry ?? row.entry_spread ?? null;
  const maeValue =
    row.mae ?? row.MAE ?? row.maxAdverseExcursion ?? row.max_adverse_excursion ?? null;
  const mfeValue =
    row.mfe ?? row.MFE ?? row.maxFavorableExcursion ?? row.max_favorable_excursion ?? null;
  const timeStopAt =
    row.timeStopAt ??
    row.time_stop_at ??
    row.timeStopAtMs ??
    row.timeStopAtTs ??
    row.timeStopAtIso ??
    row.timeStopMs ??
    null;

  return {
    ...row,
    tradeId: row.tradeId ?? row.trade_id ?? row._id ?? null,
    strategyId: row.strategyId ?? row.strategy_id ?? null,
    instrument_token,
    instrument: {
      ...instrument,
      tradingsymbol,
      exchange,
      segment,
    },
    side: row.side ?? row.transaction_type ?? null,
    qty: row.qty ?? row.quantity ?? null,
    entryPrice: row.entryPrice ?? row.entry_price ?? null,
    exitPrice: row.exitPrice ?? row.exit_price ?? null,
    stopLoss: row.stopLoss ?? row.stop_loss ?? null,
    targetPrice: row.targetPrice ?? row.target_price ?? null,
    tp1Price: row.tp1Price ?? row.tp1_price ?? null,
    slTrigger: row.slTrigger ?? row.sl_trigger ?? null,
    minGreenInr: row.minGreenInr ?? row.min_green_inr ?? null,
    minGreenPts: row.minGreenPts ?? row.min_green_pts ?? null,
    beLocked: row.beLocked ?? row.be_locked ?? null,
    peakLtp: row.peakLtp ?? row.peak_ltp ?? null,
    trailSl: row.trailSl ?? row.trail_sl ?? null,
    timeStopAt,
    status: row.status ?? null,
    closeReason: row.closeReason ?? row.close_reason ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
    regime: row.regime ?? regimeValue,
    marketRegime: row.marketRegime ?? regimeValue,
    regimeLabel: row.regimeLabel ?? regimeValue,
    regime_state: row.regime_state ?? regimeValue,
    premium: row.premium ?? premiumValue,
    entryPremium: row.entryPremium ?? premiumValue,
    entry_premium: row.entry_premium ?? premiumValue,
    entrySlippage: row.entrySlippage ?? entrySlippageValue,
    slippageEntry: row.slippageEntry ?? entrySlippageValue,
    slippage_entry: row.slippage_entry ?? entrySlippageValue,
    exitSlippage: row.exitSlippage ?? exitSlippageValue,
    slippageExit: row.slippageExit ?? exitSlippageValue,
    slippage_exit: row.slippage_exit ?? exitSlippageValue,
    slippage: row.slippage ?? totalSlippageValue,
    totalSlippage: row.totalSlippage ?? totalSlippageValue,
    slippageTotal: row.slippageTotal ?? totalSlippageValue,
    entrySpread: row.entrySpread ?? entrySpreadValue,
    spreadAtEntry: row.spreadAtEntry ?? entrySpreadValue,
    entry_spread: row.entry_spread ?? entrySpreadValue,
    spread: row.spread ?? entrySpreadValue,
    mae: row.mae ?? maeValue,
    MAE: row.MAE ?? maeValue,
    maxAdverseExcursion: row.maxAdverseExcursion ?? maeValue,
    max_adverse_excursion: row.max_adverse_excursion ?? maeValue,
    mfe: row.mfe ?? mfeValue,
    MFE: row.MFE ?? mfeValue,
    maxFavorableExcursion: row.maxFavorableExcursion ?? mfeValue,
    max_favorable_excursion: row.max_favorable_excursion ?? mfeValue,
  };
}
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
  app.use(express.json({ limit: "512kb" }));

  // ---- CORS (robust)
  app.use((req, res, next) => {
    const reqOrigin = req.headers.origin;

    // env.CORS_ORIGIN supports:
    //  - "*" (allow all)
    //  - "http://localhost:5173,http://127.0.0.1:5173"
    const raw = String(env.CORS_ORIGIN || "*").trim();
    const allowList = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const allowAll = allowList.includes("*");

    // DEV: reflect whatever Origin is sent (so Vite port changes won't break)
    let allowOrigin = "*";
    if (env.NODE_ENV !== "production") {
      allowOrigin = reqOrigin || "*";
    } else {
      // PROD: strict allowlist unless "*"
      if (allowAll) allowOrigin = reqOrigin || "*";
      else if (reqOrigin && allowList.includes(reqOrigin))
        allowOrigin = reqOrigin;
      else allowOrigin = ""; // not allowed
    }

    if (allowOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowOrigin);
      // Only vary when we are reflecting a specific origin
      if (allowOrigin !== "*") res.setHeader("Vary", "Origin");
    }

    // If you ever use cookies/sessions:
    // res.setHeader("Access-Control-Allow-Credentials", "true");

    // Allow methods
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS",
    );

    // Allow headers:
    // Echo the requested headers for maximum compatibility
    const reqHeaders = req.headers["access-control-request-headers"];
    if (reqHeaders) {
      res.setHeader("Access-Control-Allow-Headers", reqHeaders);
    } else {
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key",
      );
    }

    res.setHeader("Access-Control-Max-Age", "600");

    // Handle preflight
    if (req.method === "OPTIONS") return res.sendStatus(204);

    // If prod and origin not allowed, block early
    if (
      env.NODE_ENV === "production" &&
      reqOrigin &&
      !allowAll &&
      !allowList.includes(reqOrigin)
    ) {
      return res.status(403).json({ ok: false, error: "CORS_ORIGIN_BLOCKED" });
    }

    next();
  });
  // ------------------------------------------

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
  const rbac = buildRbac();
  app.use("/admin", rbac.roleMiddleware);
  const requirePerm = rbac.requirePermission;

  function actorFromReq(req) {
    return (
      req.header("x-user") ||
      req.header("x-user-id") ||
      req.header("x-api-key") ||
      null
    );
  }

  function getKiteClient() {
    try {
      const pipeline = getPipeline();
      return pipeline?.trader?.kite || null;
    } catch {
      return null;
    }
  }

  // Optional: FE can exchange request_token (if your Kite redirect_url points to FE).
  // In production, this endpoint is protected by ADMIN_API_KEY (same as other /admin routes).
  app.post("/admin/kite/session", requirePerm("admin"), async (req, res) => {
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

  app.get("/admin/config", requirePerm("read"), (req, res) => {
    res.json({
      tradingEnabled: getTradingEnabled(),
      tradingEnabledSource: getTradingEnabledSource(),
      tradingEnabledEnv: env.TRADING_ENABLED,
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

  app.get("/admin/trading", requirePerm("read"), (req, res) => {
    res.json({
      ok: true,
      tradingEnabled: getTradingEnabled(),
      source: getTradingEnabledSource(),
    });
  });

  app.post("/admin/trading", requirePerm("trade"), async (req, res) => {
    const raw = req.query?.enabled ?? req.body?.enabled;
    if (typeof raw === "undefined") {
      return res.status(400).json({
        ok: false,
        error: "missing_enabled",
        hint: "send enabled=true|false",
      });
    }

    const enabled = String(raw) === "true";
    try {
      const status = setTradingEnabled(enabled);
      await recordAudit({
        actor: actorFromReq(req),
        action: "trading_enabled",
        resource: "trading",
        status: "ok",
        meta: { enabled: status.enabled, source: status.source },
      });
      return res.json({ ok: true, ...status });
    } catch (e) {
      return res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
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
  app.get("/admin/health/critical", requirePerm("read"), async (req, res) => {
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

  app.get("/admin/status", requirePerm("read"), async (req, res) => {
    try {
      const pipeline = getPipeline();
      const s = await pipeline.status();
      const ticker = getTickerStatus();
      const halted = isHalted();
      const normalizedTicker = {
        connected: false,
        lastDisconnect: null,
        hasSession: false,
        ...(ticker || {}),
      };
      const dailyPnL =
        s?.dailyRisk?.lastTotal ??
        s?.dailyRisk?.lastRealizedPnl ??
        s?.dailyRisk?.realizedPnl ??
        null;
      const state = s?.dailyRiskState ?? s?.dailyRisk?.state ?? "RUNNING";
      const activeTrade = normalizeActiveTrade(s?.activeTrade);
      const activeTradeId = s?.activeTradeId ?? null;
      const targetMode =
        activeTrade?.optTargetMode ||
        (activeTrade?.targetVirtual ? "VIRTUAL" : null) ||
        (env.OPT_TARGET_MODE ? String(env.OPT_TARGET_MODE).toUpperCase() : null);
      const stopMode = activeTrade?.optStopMode || env.OPT_STOP_MODE || null;
      const targetStatus = activeTrade
        ? activeTrade?.targetOrderId
          ? activeTrade?.targetVirtual
            ? "VIRTUAL"
            : "PLACED"
          : activeTrade?.targetPrice
            ? "PENDING"
            : null
        : null;
      const tradeTracking = {
        tracker: activeTrade?.strategyId || activeTrade?.tracker || null,
        targetMode,
        targetStatus,
        stopMode,
        lastEvent: activeTrade?.lastEvent || null,
        lastUpdate: activeTrade?.updatedAt || null,
        activeTradeId,
        activeTrade,
      };
      const systemHealth = {
        lastSocketEvent: s?.lastSocketEvent || null,
        lastDisconnect: normalizedTicker.lastDisconnect || null,
        rejectedTrades:
          s?.rejectedTrades ??
          s?.dailyRisk?.rejectedTrades ??
          s?.dailyRisk?.rejections ??
          null,
      };

      res.json({
        ok: true,
        ...s,
        tradingEnabled: s?.tradingEnabled ?? getTradingEnabled(),
        killSwitch: s?.killSwitch ?? false,
        halted,
        haltInfo: getHaltInfo(),
        ticker: normalizedTicker,
        now: new Date().toISOString(),
        tradesToday: s?.tradesToday ?? 0,
        ordersPlacedToday: s?.ordersPlacedToday ?? 0,
        dailyPnL,
        state,
        activeTradeId,
        activeTrade,
        tradeTracking,
        systemHealth,
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // Market calendar diagnostics
  app.get("/admin/market/calendar", requirePerm("read"), (req, res) => {
    try {
      const meta = getMarketCalendarMeta();
      res.json({ ok: true, meta });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post(
    "/admin/market/calendar/reload",
    requirePerm("admin"),
    async (req, res) => {
      try {
        const meta = await reloadMarketCalendar();
        await recordAudit({
          actor: actorFromReq(req),
          action: "market_calendar_reload",
          resource: "market",
          status: "ok",
        });
        res.json({ ok: true, meta });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    },
  );

  // PATCH-6: Cost calibration snapshot + recent reconciliation runs
  app.get("/admin/cost/calibration", requirePerm("read"), async (req, res) => {
    try {
      const snap = costCalibrator.snapshot();
      const recent = await costCalibrator.recentRuns(10);
      res.json({ ok: true, calibration: snap, recentRuns: recent });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post(
    "/admin/cost/calibration/reload",
    requirePerm("admin"),
    async (req, res) => {
      try {
        const r = await costCalibrator.reloadFromDb();
        await recordAudit({
          actor: actorFromReq(req),
          action: "cost_calibration_reload",
          resource: "trading",
          status: "ok",
        });
        res.json({
          ok: true,
          result: r,
          calibration: costCalibrator.snapshot(),
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    },
  );

  app.get("/admin/subscriptions", requirePerm("read"), (req, res) => {
    try {
      const tokens = getSubscribedTokens ? getSubscribedTokens() : [];
      res.json({ ok: true, count: tokens.length, tokens });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // FE: recent candles for chart
  // GET /admin/candles/recent?token=123&intervalMin=1&limit=300
  app.get("/admin/candles/recent", requirePerm("read"), async (req, res) => {
    try {
      const token = Number(req.query.token);
      const intervalMin = Number(
        req.query.intervalMin || req.query.interval || 1,
      );
      const includeLive =
        String(req.query.includeLive || req.query.live || "false") === "true" ||
        String(req.query.includeLive || req.query.live || "0") === "1";

      const limitRaw = Number(req.query.limit || 300);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(2000, Math.max(10, limitRaw))
        : 300;

      if (!Number.isFinite(token) || token <= 0) {
        return res.status(400).json({ ok: false, error: "invalid_token" });
      }

      let rows = await getRecentCandles(token, intervalMin, limit);

      if (includeLive) {
        try {
          const pipeline = getPipeline();
          const live = pipeline?.getLiveCandle
            ? pipeline.getLiveCandle(token, intervalMin)
            : null;
          if (live?.ts) {
            const liveRow = { ...live, live: true, updatedAt: new Date() };
            const last = rows[rows.length - 1];
            const lastTs = last?.ts ? new Date(last.ts).getTime() : null;
            const liveTs = new Date(live.ts).getTime();
            if (Number.isFinite(lastTs) && lastTs === liveTs) {
              rows = rows.slice(0, -1).concat(liveRow);
            } else if (!Number.isFinite(lastTs) || liveTs > lastTs) {
              rows = rows.concat(liveRow);
            }
          }
        } catch {}
      }

      return res.json({ ok: true, rows });
    } catch (e) {
      return res
        .status(503)
        .json({ ok: false, error: e?.message || String(e) });
    }
  });

  // PATCH-9: DB retention (TTL) visibility + manual ensure
  app.get("/admin/db/retention", requirePerm("read"), async (req, res) => {
    try {
      const r = await describeRetention();
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post(
    "/admin/db/retention/ensure",
    requirePerm("admin"),
    async (req, res) => {
      try {
        const out = await ensureRetentionIndexes({ log: true });
        const after = await describeRetention();
        await recordAudit({
          actor: actorFromReq(req),
          action: "db_retention_ensure",
          resource: "db",
          status: "ok",
        });
        res.json({ ok: true, result: out, after });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    },
  );

  // PATCH: DB purge (delete all docs except keep list)
  app.post("/admin/db/purge", requirePerm("admin"), async (req, res) => {
    try {
      if (String(env.DB_PURGE_ENABLED || "false") !== "true") {
        return res.status(403).json({ ok: false, error: "purge_disabled" });
      }

      const confirm = String(req.body?.confirm || "");
      if (confirm !== "PURGE") {
        return res.status(400).json({
          ok: false,
          error: "confirm_required",
          hint: 'send { "confirm": "PURGE" } to proceed',
        });
      }

      const keepEnv = String(env.DB_PURGE_KEEP_COLLECTIONS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const keepBody = Array.isArray(req.body?.keepCollections)
        ? req.body.keepCollections
            .map((s) => String(s || "").trim())
            .filter(Boolean)
        : [];

      const keepSet = new Set([...keepEnv, ...keepBody]);

      const dryRun = Boolean(req.body?.dryRun);

      const db = getDb();
      const collections = await db
        .listCollections({}, { nameOnly: true })
        .toArray();

      const results = [];
      for (const c of collections || []) {
        const name = c?.name;
        if (!name) continue;
        if (name.startsWith("system.")) continue;
        if (keepSet.has(name)) continue;

        if (dryRun) {
          const count = await db.collection(name).countDocuments();
          results.push({ collection: name, deletedCount: 0, count });
        } else {
          const out = await db.collection(name).deleteMany({});
          results.push({ collection: name, deletedCount: out.deletedCount || 0 });
        }
      }

      await recordAudit({
        actor: actorFromReq(req),
        action: "db_purge",
        resource: "db",
        status: "ok",
        meta: {
          dryRun,
          keepCollections: Array.from(keepSet),
          results,
        },
      });

      return res.json({ ok: true, dryRun, keepCollections: Array.from(keepSet), results });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Derivatives universe snapshot (FUT or OPT underlying subscription)
  app.get("/admin/fno", requirePerm("read"), (req, res) => {
    try {
      const u = getLastFnoUniverse();
      res.json(u || { ok: true, enabled: false, universe: null });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post("/admin/kill", requirePerm("trade"), async (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    try {
      await getPipeline().setKillSwitch(enabled, "ADMIN");
      await recordAudit({
        actor: actorFromReq(req),
        action: "kill_switch",
        resource: "trading",
        status: "ok",
        meta: { enabled },
      });
      res.json({ ok: true, kill: enabled });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // Reset runtime HALT (does NOT disable kill-switch). Useful after fixing a bad session/API error.
  app.post("/admin/halt/reset", requirePerm("admin"), async (req, res) => {
    try {
      resetHalt();
      await recordAudit({
        actor: actorFromReq(req),
        action: "halt_reset",
        resource: "runtime",
        status: "ok",
      });
      res.json({ ok: true, halted: false, haltInfo: null });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  app.get("/admin/trades/recent", requirePerm("read"), async (req, res) => {
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

      res.json({ ok: true, rows: rows.map((row) => normalizeTradeRow(row)) });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // Account / equity service
  app.get("/admin/account/equity", requirePerm("read"), async (req, res) => {
    try {
      const kite = getKiteClient();
      const data = await equityService.snapshot({ kite });
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Live positions snapshot
  app.get("/admin/positions", requirePerm("read"), async (req, res) => {
    try {
      const kite = getKiteClient();
      const rows = await buildPositionsSnapshot({ kite });
      res.json({ ok: true, rows });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Orders & OMS endpoints
  app.get("/admin/orders", requirePerm("read"), async (req, res) => {
    try {
      const kite = getKiteClient();
      const rows = await getOrdersSnapshot({ kite });
      res.json({ ok: true, rows });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get("/admin/orders/history", requirePerm("read"), async (req, res) => {
    try {
      const orderId = req.query.orderId || req.query.order_id;
      if (!orderId) {
        return res.status(400).json({ ok: false, error: "missing_order_id" });
      }
      const kite = getKiteClient();
      const rows = await getOrderHistory({ kite, orderId });
      res.json({ ok: true, rows });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get("/admin/orders/logs", requirePerm("read"), async (req, res) => {
    try {
      const orderId = req.query.orderId || req.query.order_id;
      const tradeId = req.query.tradeId || req.query.trade_id || null;
      const limit = Number(req.query.limit || 200);
      const rows = await getOrderLogsSnapshot({
        orderId,
        tradeId,
        limit,
      });
      res.json({ ok: true, rows });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Risk limits (portfolio-level)
  app.get("/admin/risk/limits", requirePerm("read"), async (req, res) => {
    try {
      const limits = await getRiskLimits();
      const resolved = limits?.limits || {};
      const maxDailyLoss = resolved.dailyLossCapInr ?? null;
      const maxDrawdown = resolved.maxDrawdownInr ?? null;
      const maxOpenTrades = resolved.maxOpenTrades ?? null;
      const maxExposureInr = resolved.maxPortfolioExposureInr ?? null;
      const positions = await buildPositionsSnapshot({ kite: getKiteClient() });
      const exposureBySymbol = {};
      for (const p of positions) {
        const key = p.tradingsymbol || String(p.instrument_token || "");
        exposureBySymbol[key] =
          (exposureBySymbol[key] || 0) + (p.exposureInr || 0);
      }
      res.json({
        ok: true,
        ...limits,
        maxDailyLoss,
        maxDrawdown,
        maxOpenTrades,
        maxExposureInr,
        usage: {
          openPositions: positions.length,
          exposureBySymbol,
        },
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post("/admin/risk/limits", requirePerm("admin"), async (req, res) => {
    try {
      const limits = await setRiskLimits(req.body || {});
      const pipeline = getPipeline();
      await pipeline?.trader?.refreshRiskLimits?.();
      await recordAudit({
        actor: actorFromReq(req),
        action: "risk_limits_update",
        resource: "risk",
        status: "ok",
        meta: limits,
      });
      res.json({ ok: true, limits });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Strategy telemetry (KPIs)
  app.get("/admin/strategy/kpis", requirePerm("read"), async (req, res) => {
    try {
      const limit = Number(req.query.limit || 500);
      const data = await getStrategyKpis({ limit });
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Execution quality stats
  app.get("/admin/execution/quality", requirePerm("read"), async (req, res) => {
    try {
      const limit = Number(req.query.limit || 500);
      const data = await getExecutionQuality({ limit });
      res.json({
        ok: true,
        ...data,
        fillRate: data?.fillRate ?? null,
        avgSlippage:
          data?.slippage?.avgEntrySlippageBps ??
          data?.slippage?.avgExitSlippageInr ??
          null,
        avgLatencyMs:
          data?.latency?.orderPlacementMs ??
          data?.latency?.orderFillMs ??
          data?.latency?.exitFillMs ??
          null,
        rejects: data?.rejections ?? {},
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Market data health
  app.get("/admin/market/health", requirePerm("read"), (req, res) => {
    try {
      const tokens = req.query.tokens
        ? String(req.query.tokens)
            .split(",")
            .map((t) => Number(t.trim()))
            .filter((n) => Number.isFinite(n))
        : null;
      const data = marketHealth.snapshot({ tokens });
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Audit & compliance logs
  app.get("/admin/audit/logs", requirePerm("read"), async (req, res) => {
    try {
      const limit = Number(req.query.limit || 100);
      const rows = await listAuditLogs({ limit });
      res.json({ ok: true, rows });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Alerting/notification channels
  app.get("/admin/alerts/channels", requirePerm("read"), async (req, res) => {
    try {
      const rows = await listChannels();
      res.json({ ok: true, rows });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post("/admin/alerts/channels", requirePerm("admin"), async (req, res) => {
    try {
      const channel = await addChannel(req.body || {});
      await recordAudit({
        actor: actorFromReq(req),
        action: "alerts_channel_add",
        resource: "alerts",
        status: "ok",
        meta: { id: channel._id, type: channel.type },
      });
      res.json({ ok: true, channel });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.delete(
    "/admin/alerts/channels/:id",
    requirePerm("admin"),
    async (req, res) => {
      try {
        await removeChannel(req.params.id);
        await recordAudit({
          actor: actorFromReq(req),
          action: "alerts_channel_remove",
          resource: "alerts",
          status: "ok",
          meta: { id: req.params.id },
        });
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
      }
    },
  );

  app.get("/admin/alerts/incidents", requirePerm("read"), async (req, res) => {
    try {
      const limit = Number(req.query.limit || 100);
      const rows = await listIncidents({ limit });
      res.json({ ok: true, rows });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post("/admin/alerts/test", requirePerm("admin"), async (req, res) => {
    try {
      const payload = {
        type: req.body?.type || "test",
        message: req.body?.message || "Test notification",
        severity: req.body?.severity || "info",
        meta: req.body?.meta || null,
      };
      const out = await emitNotification(payload);
      await recordAudit({
        actor: actorFromReq(req),
        action: "alerts_test",
        resource: "alerts",
        status: "ok",
        meta: payload,
      });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // RBAC configuration visibility
  app.get("/admin/rbac", requirePerm("read"), (req, res) => {
    res.json({
      ok: true,
      enabled: rbac.enabled,
      header: rbac.header,
      defaultRole: rbac.defaultRole,
      roles: rbac.roles,
    });
  });

  // Telemetry endpoints (signal observability)
  app.get(
    "/admin/telemetry/snapshot",
    requirePerm("read"),
    async (req, res) => {
      const snapshot = telemetry.snapshot();
      const isEmpty =
        Number(snapshot.candidatesTotal || 0) === 0 &&
        Number(snapshot.decisionsTotal || 0) === 0 &&
        Number(snapshot.blockedTotal || 0) === 0;

      if (!isEmpty) {
        res.json({ ok: true, source: "memory", data: snapshot });
        return;
      }

      const doc = await telemetry.readDailyFromDb(snapshot.dayKey);
      if (doc) {
        res.json({ ok: true, source: "db", data: doc });
        return;
      }

      res.json({ ok: true, source: "memory", data: snapshot });
    },
  );

  app.post("/admin/telemetry/flush", requirePerm("admin"), async (req, res) => {
    try {
      const out = await telemetry.flush();
      await recordAudit({
        actor: actorFromReq(req),
        action: "telemetry_flush",
        resource: "telemetry",
        status: "ok",
      });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get("/admin/telemetry/daily", requirePerm("read"), async (req, res) => {
    try {
      const dk = req.query.dayKey;
      const doc = await telemetry.readDailyFromDb(dk);
      res.json({ ok: !!doc, dayKey: dk || telemetry.snapshot().dayKey, doc });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Trade telemetry endpoints (fee-multiple + pnl vs costs)
  app.get(
    "/admin/trade-telemetry/snapshot",
    requirePerm("read"),
    (req, res) => {
      const data = tradeTelemetry.snapshot();
      const lastUpdated = data?.lastUpdated ?? data?.updatedAt ?? null;
      res.json({
        ok: true,
        data: {
          ...data,
          targetMode: data?.targetMode ?? null,
          targetStatus: data?.targetStatus ?? null,
          stopMode: data?.stopMode ?? null,
          trackerStatus: data?.trackerStatus ?? null,
          lastEvent: data?.lastEvent ?? null,
          lastUpdated,
          target_mode: data?.target_mode ?? data?.targetMode ?? null,
          target_status: data?.target_status ?? data?.targetStatus ?? null,
          stop_mode: data?.stop_mode ?? data?.stopMode ?? null,
          tracker_status: data?.tracker_status ?? data?.trackerStatus ?? null,
          last_event: data?.last_event ?? data?.lastEvent ?? null,
          last_updated: data?.last_updated ?? lastUpdated,
        },
      });
    },
  );

  app.post(
    "/admin/trade-telemetry/flush",
    requirePerm("admin"),
    async (req, res) => {
      try {
        const out = await tradeTelemetry.flush();
        await recordAudit({
          actor: actorFromReq(req),
          action: "trade_telemetry_flush",
          resource: "telemetry",
          status: "ok",
        });
        res.json({ ok: true, ...out });
      } catch (e) {
        res.status(503).json({ ok: false, error: e?.message || String(e) });
      }
    },
  );

  app.get(
    "/admin/trade-telemetry/daily",
    requirePerm("read"),
    async (req, res) => {
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
    },
  );

  // Adaptive optimizer endpoints (fee-multiple tuning)
  app.get("/admin/optimizer/snapshot", requirePerm("read"), (req, res) => {
    try {
      res.json({ ok: true, data: optimizer.snapshot() });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Alias for convenience (dashboards often expect /admin/optimizer)
  app.get("/admin/optimizer", requirePerm("read"), (req, res) => {
    try {
      res.json({ ok: true, data: optimizer.snapshot() });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Force persistence flush (DB-persisted optimizer state)
  app.post(
    "/admin/optimizer/flush",
    requirePerm("admin"),
    async (req, res) => {
      try {
        const out = await optimizer.flushState({ force: true });
        await recordAudit({
          actor: actorFromReq(req),
          action: "optimizer_flush",
          resource: "optimizer",
          status: "ok",
        });
        res.json({ ok: true, ...out });
      } catch (e) {
        res.status(503).json({ ok: false, error: e?.message || String(e) });
      }
    },
  );

  app.post(
    "/admin/optimizer/reload",
    requirePerm("admin"),
    async (req, res) => {
      try {
        const out = await optimizer.reloadFromDb();
        await recordAudit({
          actor: actorFromReq(req),
          action: "optimizer_reload",
          resource: "optimizer",
          status: "ok",
        });
        res.json({ ok: true, ...out });
      } catch (e) {
        res.status(503).json({ ok: false, error: e?.message || String(e) });
      }
    },
  );

  app.post("/admin/optimizer/reset", requirePerm("admin"), (req, res) => {
    try {
      optimizer.reset();
      void recordAudit({
        actor: actorFromReq(req),
        action: "optimizer_reset",
        resource: "optimizer",
        status: "ok",
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Rejection histograms (symbol×strategy×timeBucket) for tuning
  app.get("/admin/rejections", requirePerm("read"), async (req, res) => {
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
