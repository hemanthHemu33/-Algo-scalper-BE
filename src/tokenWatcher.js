// src/tokenWatcher.js
const { env } = require("./config");
const { logger } = require("./logger");
const { alert } = require("./alerts/alertService");
const { getDb } = require("./db");
const { readLatestTokenDoc } = require("./tokenStore");

async function watchLatestToken({ onToken }) {
  const db = getDb();
  const col = db.collection(env.TOKENS_COLLECTION);

  let lastToken = null;

  // Missing-token notification state (avoid spamming)
  let missing = false;
  let lastMissingAlertAt = 0;

  const maybeNotifyMissing = async (meta) => {
    const now = Date.now();
    const everyMs = 30 * 60 * 1000; // 30 minutes
    if (now - lastMissingAlertAt < everyMs) return;

    lastMissingAlertAt = now;

    const details = {
      collection: meta?.collection || env.TOKENS_COLLECTION,
      filter: meta?.filter || {},
      reason: meta?.reason || "NO_TOKEN",
      hint: "Login to Kite via your token generator/scanner app OR insert/update a doc with access_token in this collection.",
    };

    logger.error(details, "[tokenWatcher] kite access token missing");
    alert(
      "warn",
      "🔑 Kite access token missing. Please login to Kite and sync token to Mongo.",
      details
    ).catch(() => {});
  };

  const refreshAndNotify = async (reason = "manual") => {
    const res = await readLatestTokenDoc();

    // No doc / no access token -> keep the process alive and notify operator.
    if (!res?.accessToken) {
      if (!missing) {
        missing = true;
        lastToken = null;
      }
      logger.warn(
        {
          reason,
          tokenReason: res?.reason,
          collection: res?.collection || env.TOKENS_COLLECTION,
          filter: res?.filter || {},
        },
        "[tokenWatcher] no usable kite token. Engine will stay up and wait."
      );
      await maybeNotifyMissing(res);
      return;
    }

    const accessToken = String(res.accessToken);
    missing = false;

    if (accessToken === lastToken) return;

    lastToken = accessToken;
    logger.info(
      { reason, updatedAt: res?.doc?.updatedAt || null },
      "[token] loaded/updated"
    );
    alert("info", "🔑 Kite token loaded/updated").catch(() => {});
    await onToken(accessToken, res?.doc || null, reason);
  };

  // Initial refresh should never crash the app now
  await refreshAndNotify("startup");

  // Best-effort: Change stream watch (replica set / Atlas)
  let changeStream = null;
  try {
    changeStream = col.watch([], { fullDocument: "updateLookup" });
    changeStream.on("change", async () => {
      try {
        await refreshAndNotify("change_stream");
      } catch (e) {
        logger.warn(
          { e: e.message },
          "[tokenWatcher] refresh failed on change"
        );
      }
    });
    changeStream.on("error", (err) => {
      logger.warn(
        { e: err?.message || String(err) },
        "[tokenWatcher] change stream error (will rely on polling)"
      );
    });
    logger.info("[tokenWatcher] change stream started (collection-wide)");
  } catch (e) {
    logger.warn(
      { e: e.message },
      "[tokenWatcher] change streams not available (will rely on polling)"
    );
  }

  // Polling fallback: keeps working even if change streams are not supported
  const pollMs = Math.max(5000, Number(env.TOKEN_POLL_INTERVAL_MS || 30000));
  const interval = setInterval(() => {
    refreshAndNotify("poll").catch(() => {});
  }, pollMs);

  return () => {
    clearInterval(interval);
    if (changeStream) {
      try {
        changeStream.close();
      } catch {}
    }
  };
}

module.exports = { watchLatestToken };
