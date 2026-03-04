// src/tokenStore.js
const { env } = require("./config");
const { getDb, getClient } = require("./db");

// Optional override: read token documents from a different Mongo DB than env.MONGO_DB.
// Useful when you write backtest candles to a dedicated DB (e.g. scanner_app_bt)
// but keep login/access tokens in the primary DB (e.g. scanner_app).
//
// Example:
//   MONGO_DB=scanner_app_bt
//   TOKENS_DB=scanner_app
//   TOKENS_COLLECTION=broker_tokens
function getTokensDb() {
  const tokensDbName = String(process.env.TOKENS_DB || "").trim();
  if (!tokensDbName || tokensDbName === String(env.MONGO_DB)) {
    return getDb();
  }

  // Reuse the already-connected MongoClient (connectMongo must have been called).
  const client = getClient();
  return client.db(tokensDbName);
}

async function readLatestTokenDoc() {
  const db = getTokensDb();
  const col = db.collection(env.TOKENS_COLLECTION);

  const filter = {};
  if (env.TOKEN_FILTER_USER_ID) filter.user_id = env.TOKEN_FILTER_USER_ID;
  if (env.TOKEN_FILTER_API_KEY) filter.api_key = env.TOKEN_FILTER_API_KEY;

  const doc = await col
    .aggregate([
      { $match: filter },
      {
        $addFields: {
          sortUpdatedAt: { $ifNull: ["$updatedAt", "$createdAt"] },
        },
      },
      { $sort: { sortUpdatedAt: -1, createdAt: -1, _id: -1 } },
      { $limit: 1 },
    ])
    .next();

  // IMPORTANT: Don't crash the engine if there is no token yet.
  // We'll keep running and let tokenWatcher poll / watch for a login update.
  if (!doc) {
    return {
      doc: null,
      accessToken: null,
      reason: "NO_TOKEN_DOC",
      filter,
      collection: env.TOKENS_COLLECTION,
      tokensDb: String(process.env.TOKENS_DB || env.MONGO_DB),
    };
  }

  const accessToken =
    doc.access_token ||
    doc.accessToken ||
    doc.token ||
    doc.access ||
    doc.kite_access_token ||
    null;

  if (!accessToken || String(accessToken).trim().length < 5) {
    return {
      doc,
      accessToken: null,
      reason: "MISSING_ACCESS_TOKEN",
      filter,
      collection: env.TOKENS_COLLECTION,
      tokensDb: String(process.env.TOKENS_DB || env.MONGO_DB),
    };
  }

  if (doc && !doc.updatedAt && doc.createdAt) {
    doc.updatedAt = doc.createdAt;
  }

  return { doc, accessToken: String(accessToken) };
}

module.exports = { readLatestTokenDoc };
