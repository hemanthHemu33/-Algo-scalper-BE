// src/kite/kiteLogin.js
// Kite Connect login/token-exchange helpers.
//
// Flow:
//  - Kite redirects to your redirect_url with ?request_token=...
//  - Backend exchanges request_token -> access_token using api_secret
//  - Persist into TOKENS_COLLECTION as { type: "kite_session", ...session }
//  - Best-effort: apply session immediately to tickerManager (no need to wait for poll)
//
// IMPORTANT: api_secret must never be exposed to the frontend.

const KiteConnect = require("kiteconnect").KiteConnect;
const { env } = require("../config");
const { getDb } = require("../db");
const { logger } = require("../logger");
const { setSession } = require("./tickerManager");

function _now() {
  return new Date();
}

async function persistKiteSession({ session, requestToken }) {
  const db = getDb();
  const col = db.collection(env.TOKENS_COLLECTION);

  const filter = { type: "kite_session" };
  const update = {
    $set: {
      ...session,
      request_token: requestToken,
      type: "kite_session",
      updatedAt: _now(),
    },
    $setOnInsert: { createdAt: _now() },
  };

  await col.updateOne(filter, update, { upsert: true });
}

async function exchangeAndStoreKiteSession({ requestToken, source = "unknown" } = {}) {
  const rt = String(requestToken || "").trim();
  if (!rt) throw new Error("Missing request_token");

  const secret = env.KITE_API_SECRET;
  if (!secret) {
    throw new Error(
      "KITE_API_SECRET not configured (required to exchange request_token -> access_token)",
    );
  }

  const kc = new KiteConnect({ api_key: env.KITE_API_KEY });
  const session = await kc.generateSession(rt, secret);

  // Optional safety: prevent overwriting token with a different Kite user.
  if (env.KITE_ALLOWED_USER_ID) {
    const allowed = String(env.KITE_ALLOWED_USER_ID).trim();
    const actual = String(session?.user_id || "").trim();
    if (allowed && actual && allowed !== actual) {
      throw new Error(
        `Logged-in user_id (${actual}) does not match KITE_ALLOWED_USER_ID (${allowed})`,
      );
    }
  }

  await persistKiteSession({ session, requestToken: rt });

  // Best-effort: apply token immediately so engine connects without waiting for tokenWatcher poll.
  try {
    if (session?.access_token) {
      await setSession(String(session.access_token));
    }
  } catch (e) {
    logger.warn(
      { source, e: e?.message || String(e) },
      "[kite-login] setSession failed (token persisted; tokenWatcher will retry)",
    );
  }

  logger.info(
    {
      source,
      user_id: session?.user_id || null,
      api_key: session?.api_key || null,
    },
    "[kite-login] session generated + persisted",
  );

  return session;
}

module.exports = { exchangeAndStoreKiteSession };
