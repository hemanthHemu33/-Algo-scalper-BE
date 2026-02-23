const { env } = require("./config");
const { logger } = require("./logger");
const { alert } = require("./alerts/alertService");
const { halt } = require("./runtime/halt");
const { upsertDailyRisk } = require("./trading/tradeStore");
const { DateTime } = require("luxon");
const dns = require("node:dns/promises");
const { connectMongo, closeMongo } = require("./db");
const { ensureRetentionIndexes } = require("./market/retention");
const { buildApp } = require("./app");
const { watchLatestToken } = require("./tokenWatcher");
const { setSession, shutdownAll } = require("./kite/tickerManager");
const { telemetry } = require("./telemetry/signalTelemetry");
const { tradeTelemetry } = require("./telemetry/tradeTelemetry");
const { optimizer } = require("./optimizer/adaptiveOptimizer");
const http = require("http");
const { attachSocketServer } = require("./socket/socketServer");
const { reportFault } = require("./runtime/errorBus");

function applyWindowsSrvDnsWorkaround() {
  // Workaround for Node.js Windows SRV DNS regressions that can manifest as:
  //   querySrv ECONNREFUSED _mongodb._tcp.<cluster>.mongodb.net
  // Only apply when using mongodb+srv URIs.
  try {
    if (process.platform !== "win32") return;
    const uri = String(env.MONGO_URI || "");
    if (!uri.startsWith("mongodb+srv://")) return;

    const enabled =
      String(process.env.DNS_SRV_WORKAROUND || "true") !== "false";
    if (!enabled) return;

    const servers = String(process.env.DNS_SERVERS || "1.1.1.1,8.8.8.8")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // dns.setServers() is synchronous (even under dns/promises)
    dns.setServers(servers);
    logger.warn(
      { servers },
      "[dns] SRV workaround enabled (custom DNS servers set)",
    );
  } catch (e) {
    logger.warn(
      { err: { message: e?.message, name: e?.name } },
      "[dns] SRV workaround failed to apply (continuing)",
    );
  }
}

function describeErr(e) {
  if (!e) return { name: "UnknownError", message: "(no error)", stack: "" };
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  // non-Error throws (string/object/etc.)
  return {
    name: typeof e,
    message: typeof e === "string" ? e : JSON.stringify(e),
    stack: "",
  };
}

function todayKey() {
  return DateTime.now()
    .setZone(env.CANDLE_TZ || "Asia/Kolkata")
    .toFormat("yyyy-LL-dd");
}

async function persistKill(reason, meta) {
  try {
    await upsertDailyRisk(todayKey(), {
      kill: true,
      reason: String(reason || "RUNTIME_FATAL"),
      meta: meta || null,
      updatedAt: new Date(),
    });
  } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }
}

function exitAfterCrash(delayMs = 750) {
  setTimeout(() => process.exit(1), delayMs).unref();
}

async function main() {
  // Apply SRV DNS workaround early (before Mongo connects)
  applyWindowsSrvDnsWorkaround();
  await connectMongo();
  // PATCH-9: Ensure candle retention TTL indexes (prevents MongoDB growth)
  try {
    if (String(env.RETENTION_ENSURE_ON_START || "true") === "true") {
      await ensureRetentionIndexes({
        log: String(env.CANDLE_TTL_LOG || "true") === "true",
      });
    }
  } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }

  telemetry.start();
  tradeTelemetry.start();
  // Adaptive optimizer (auto-block weak strategy×symbol×bucket + dynamic RR)
  try {
    await optimizer.start();
  } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }

  const stopTokenWatcher = await watchLatestToken({
    onMissing: async (doc, reason) => {
      const updatedAt = doc?.updatedAt || doc?.createdAt || null;

      logger.error(
        { reason, updatedAt },
        "[tokenWatcher] kite access token missing (engine will stay up and keep polling)",
      );
      alert("error", "🔐 Kite access token missing — please login to Kite", {
        reason,
        hint: "Login via your token generator/scanner app or insert/update a doc with access_token in TOKENS_COLLECTION",
      }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
      await halt("KITE_TOKEN_MISSING", { reason, updatedAt });
    },
    onToken: async (accessToken, doc, reason) => {
      const updatedAt = doc?.updatedAt || doc?.createdAt || null;

      // Defensive guard: tokenWatcher should invoke onMissing for this path.
      if (!accessToken) {
        return;
      }

      logger.info({ reason, updatedAt }, "[token] loaded/updated");
      alert("info", "🔑 Kite token loaded/updated", {
        reason,
        updatedAt,
      }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });

      try {
        await setSession(accessToken);
      } catch (e) {
        const err = describeErr(e);
        logger.error(
          { reason, updatedAt, err },
          "[kite] setSession failed (trading halted; waiting for token refresh)",
        );
        alert("error", "⚠️ Kite session init failed (trading halted)", {
          reason,
          ...err,
          hint: "Re-login to Kite to refresh the access_token",
        }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
        await halt("KITE_SESSION_INIT_FAILED", { reason, ...err });
        // Do NOT throw — avoid killing the process; tokenWatcher will keep polling.
      }
    },
  });

  const app = buildApp();
  const httpServer = http.createServer(app);
  const io = attachSocketServer(httpServer);
  const server = httpServer.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "server started");
    alert("info", "🚀 Scalper engine started", {
      port: env.PORT,
      env: env.NODE_ENV || "dev",
    }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn({ signal }, "shutdown");
    alert("warn", `🧯 Shutdown signal: ${signal}`, { signal }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });

    try {
      if (typeof stopTokenWatcher === "function") {
        await stopTokenWatcher();
      }
    } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }

    try {
      await shutdownAll(`signal_${signal}`);
    } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }

    try {
      if (io) io.close();
    } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }

    try {
      await new Promise((resolve) => {
        server.close(() => {
          logger.warn("server closed");
          resolve();
        });
      });
    } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }

    try {
      await closeMongo();
    } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }

    setTimeout(() => process.exit(0), 200).unref();
  };

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
}

process.on("unhandledRejection", async (reason) => {
  const msg = reason?.message || String(reason);
  logger.error({ reason: msg }, "unhandledRejection");
  alert("error", "💥 unhandledRejection (trading halted)", {
    message: msg,
  }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
  await halt("UNHANDLED_REJECTION", { message: msg });
  await persistKill("UNHANDLED_REJECTION", { message: msg });
  exitAfterCrash();
});

process.on("uncaughtException", async (err) => {
  const msg = err?.message || String(err);
  logger.error({ err: msg, stack: err?.stack }, "uncaughtException");
  alert("error", "💥 uncaughtException (trading halted)", {
    message: msg,
  }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
  await halt("UNCAUGHT_EXCEPTION", { message: msg, stack: err?.stack });
  await persistKill("UNCAUGHT_EXCEPTION", { message: msg });
  exitAfterCrash();
});

main().catch((e) => {
  const err = describeErr(e);
  // Use a structured object that preserves error details (pino won't serialize Error well under key "e").
  logger.error({ err }, "fatal");
  alert("error", "💥 Scalper engine crashed (fatal)", err).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
  process.exit(1);
});
