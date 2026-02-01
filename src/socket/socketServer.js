const { Server } = require("socket.io");
const { env } = require("../config");
const { logger } = require("../logger");
const {
  getPipeline,
  getTickerStatus,
  getSubscribedTokens,
} = require("../kite/tickerManager");
const { isHalted, getHaltInfo } = require("../runtime/halt");
const { getDb } = require("../db");
const { getRecentCandles, getCandlesSince } = require("../market/candleStore");

function parseCorsAllowList() {
  const raw = String(env.CORS_ORIGIN || "*").trim();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsOriginFn(origin, cb) {
  try {
    const allowList = parseCorsAllowList();
    const allowAll = allowList.includes("*");

    // DEV: allow all (Vite port changes should not break)
    if (env.NODE_ENV !== "production") {
      return cb(null, true);
    }

    // PROD: allow only allowlist unless "*"
    if (allowAll) return cb(null, true);
    if (!origin) return cb(null, false);
    if (allowList.includes(origin)) return cb(null, true);
    return cb(null, false);
  } catch (e) {
    return cb(e, false);
  }
}

function assertAdminKey(socket) {
  const expected = env.ADMIN_API_KEY;

  // In production, require a key.
  if (!expected && env.NODE_ENV === "production") {
    const err = new Error("ADMIN_API_KEY not configured");
    err.data = { code: "ADMIN_API_KEY_MISSING" };
    throw err;
  }

  // In dev, if key is not set, allow.
  if (!expected) return;

  const provided =
    socket?.handshake?.auth?.apiKey ||
    socket?.handshake?.headers?.["x-api-key"] ||
    null;

  if (provided && provided === expected) return;

  const err = new Error("unauthorized");
  err.data = { code: "UNAUTHORIZED" };
  throw err;
}

async function buildStatusSnapshot() {
  const pipeline = getPipeline();
  const s = await pipeline.status();
  const ticker = getTickerStatus();
  const halted = isHalted();
  return {
    ok: true,
    ...s,
    halted,
    haltInfo: getHaltInfo(),
    ticker,
    now: new Date().toISOString(),
  };
}

function safeJsonHash(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(Date.now());
  }
}

function attachSocketServer(httpServer) {
  const enabled = String(env.SOCKET_ENABLED || "true") === "true";
  if (!enabled) {
    logger.warn("[socket] SOCKET_ENABLED=false (disabled)");
    return null;
  }

  const io = new Server(httpServer, {
    path: env.SOCKET_PATH || "/socket.io",
    cors: {
      origin: corsOriginFn,
      methods: ["GET", "POST"],
      allowedHeaders: ["x-api-key", "authorization", "content-type"],
    },
    transports: ["websocket", "polling"],
  });

  io.use((socket, next) => {
    try {
      assertAdminKey(socket);
      return next();
    } catch (e) {
      return next(e);
    }
  });

  io.on("connection", (socket) => {
    const sid = socket.id;

    socket.emit("server:hello", {
      ok: true,
      sid,
      now: new Date().toISOString(),
      env: env.NODE_ENV,
    });

    const timers = new Map();
    const chartSubs = new Map();

    let lastStatusHash = null;
    let lastSubsHash = null;

    // ---- helpers
    const stopTimer = (key) => {
      const t = timers.get(key);
      if (t) clearInterval(t);
      timers.delete(key);
    };

    const startTimer = (key, intervalMs, fn) => {
      stopTimer(key);
      const ms = Math.max(200, Number(intervalMs) || 1000);
      const t = setInterval(() => {
        fn().catch((e) => {
          socket.emit("server:error", {
            ok: false,
            channel: key,
            error: e?.message || String(e),
          });
        });
      }, ms);
      timers.set(key, t);
    };

    const sendStatus = async () => {
      const snap = await buildStatusSnapshot();
      const h = safeJsonHash(snap);
      if (h !== lastStatusHash) {
        lastStatusHash = h;
        socket.emit("status:update", snap);
      }
    };

    const sendSubs = async () => {
      const tokens = getSubscribedTokens ? getSubscribedTokens() : [];
      const snap = { ok: true, count: tokens.length, tokens };
      const h = safeJsonHash(snap);
      if (h !== lastSubsHash) {
        lastSubsHash = h;
        socket.emit("subs:update", snap);
      }
    };

    const sendTradesSnapshot = async (limit = 50) => {
      const lim = Number(limit);
      const safeLimit = Number.isFinite(lim) ? Math.min(200, Math.max(1, lim)) : 50;
      const db = getDb();
      const rows = await db
        .collection("trades")
        .find({})
        .sort({ createdAt: -1 })
        .limit(safeLimit)
        .toArray();
      socket.emit("trades:snapshot", { ok: true, rows });
      return rows;
    };

    // trades: keep a per-socket tail cursor
    let tradesCursorMs = 0;

    const pollTradesDelta = async () => {
      const since = tradesCursorMs;
      if (!since) return;
      const db = getDb();
      const rows = await db
        .collection("trades")
        .find({ createdAt: { $gt: new Date(since) } })
        .sort({ createdAt: 1 })
        .limit(200)
        .toArray();

      if (rows.length) {
        const last = rows[rows.length - 1];
        const lastMs = new Date(last.createdAt || last.updatedAt || Date.now()).getTime();
        if (Number.isFinite(lastMs) && lastMs > tradesCursorMs) tradesCursorMs = lastMs;
        socket.emit("trades:delta", { ok: true, rows });
      }
    };

    const sendChartSnapshot = async (sub) => {
      const rows = await getRecentCandles(sub.token, sub.intervalMin, sub.limit);
      const last = rows[rows.length - 1];
      sub.lastTsMs = last ? new Date(last.ts).getTime() : 0;
      sub.lastUpdatedAtMs = last ? new Date(last.updatedAt || last.ts).getTime() : 0;
      socket.emit("chart:snapshot", {
        ok: true,
        chartId: sub.chartId,
        token: sub.token,
        intervalMin: sub.intervalMin,
        rows,
      });
    };

    const pollCharts = async () => {
      if (!chartSubs.size) return;

      for (const sub of chartSubs.values()) {
        const since = sub.lastTsMs;
        if (!since) {
          await sendChartSnapshot(sub);
          continue;
        }

        const rows = await getCandlesSince(
          sub.token,
          sub.intervalMin,
          since,
          Math.min(env.WS_CHART_MAX_DELTA || 200, 2000),
        );

        if (!rows.length) continue;

        const last = rows[rows.length - 1];
        const lastTs = new Date(last.ts).getTime();
        const lastUpd = new Date(last.updatedAt || last.ts).getTime();

        // If the only row returned is the same candle and updatedAt didn't change, skip emitting.
        if (rows.length === 1 && lastTs === sub.lastTsMs && lastUpd === sub.lastUpdatedAtMs) {
          continue;
        }

        sub.lastTsMs = lastTs;
        sub.lastUpdatedAtMs = lastUpd;

        socket.emit("chart:delta", {
          ok: true,
          chartId: sub.chartId,
          token: sub.token,
          intervalMin: sub.intervalMin,
          rows,
        });
      }
    };

    // ---- events from client (FE -> BE)

    socket.on("status:subscribe", (payload = {}) => {
      const intervalMs = Number(payload.intervalMs || env.WS_STATUS_INTERVAL_MS || 2000);
      sendStatus().catch(() => {});
      startTimer("status", intervalMs, sendStatus);
    });

    socket.on("status:request", () => {
      sendStatus().catch(() => {});
    });

    socket.on("status:unsubscribe", () => {
      stopTimer("status");
    });

    socket.on("subs:subscribe", (payload = {}) => {
      const intervalMs = Number(payload.intervalMs || env.WS_SUBS_INTERVAL_MS || 5000);
      sendSubs().catch(() => {});
      startTimer("subs", intervalMs, sendSubs);
    });

    socket.on("subs:request", () => {
      sendSubs().catch(() => {});
    });

    socket.on("subs:unsubscribe", () => {
      stopTimer("subs");
    });

    socket.on("trades:subscribe", async (payload = {}) => {
      const intervalMs = Number(payload.intervalMs || env.WS_TRADES_INTERVAL_MS || 2000);
      const limit = Number(payload.limit || 50);
      const rows = await sendTradesSnapshot(limit);
      const mostRecent = rows[0];
      const cursor = mostRecent ? new Date(mostRecent.createdAt || mostRecent.updatedAt || Date.now()).getTime() : 0;
      tradesCursorMs = cursor || Date.now();
      startTimer("trades", intervalMs, pollTradesDelta);
    });

    socket.on("trades:unsubscribe", () => {
      stopTimer("trades");
      tradesCursorMs = 0;
    });

    socket.on("chart:subscribe", async (payload = {}) => {
      const chartId = String(payload.chartId || "");
      const token = Number(payload.token);
      const intervalMin = Number(payload.intervalMin || 1);
      const limitRaw = Number(payload.limit || 300);
      const limit = Number.isFinite(limitRaw) ? Math.min(2000, Math.max(10, limitRaw)) : 300;

      if (!chartId) {
        socket.emit("server:error", { ok: false, channel: "chart", error: "missing_chartId" });
        return;
      }
      if (!Number.isFinite(token) || token <= 0) {
        socket.emit("server:error", { ok: false, channel: "chart", error: "invalid_token" });
        return;
      }
      if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
        socket.emit("server:error", { ok: false, channel: "chart", error: "invalid_interval" });
        return;
      }

      const sub = {
        chartId,
        token,
        intervalMin,
        limit,
        lastTsMs: 0,
        lastUpdatedAtMs: 0,
      };

      chartSubs.set(chartId, sub);
      await sendChartSnapshot(sub);

      // Start global chart polling if not already
      if (!timers.get("charts")) {
        const intervalMs = Number(env.WS_CHART_INTERVAL_MS || 1000);
        startTimer("charts", intervalMs, pollCharts);
      }
    });

    socket.on("chart:unsubscribe", (payload = {}) => {
      const chartId = String(payload.chartId || "");
      if (chartId) chartSubs.delete(chartId);
      if (!chartSubs.size) stopTimer("charts");
    });

    // Optional: lightweight client pings (for UI debugging)
    socket.on("client:ping", (payload = {}) => {
      socket.emit("server:pong", { ok: true, now: new Date().toISOString(), echo: payload });
    });

    socket.on("disconnect", () => {
      for (const t of timers.values()) clearInterval(t);
      timers.clear();
      chartSubs.clear();
      logger.info({ sid }, "[socket] disconnect");
    });

    logger.info({ sid }, "[socket] connected");
  });

  logger.info({ path: env.SOCKET_PATH || "/socket.io" }, "[socket] attached");

  return io;
}

module.exports = { attachSocketServer };
