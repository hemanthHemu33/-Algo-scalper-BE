const { MongoClient } = require("mongodb");
const dns = require("dns");
const { env } = require("./config");
const { logger } = require("./logger");

let client;
let db;

function applySrvDnsWorkaround() {
  // Workaround for Windows SRV DNS failures like:
  // querySrv ECONNREFUSED _mongodb._tcp.<cluster>.mongodb.net
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

async function connectMongo() {
  if (db) return { client, db };

  // ✅ apply workaround for scripts too
  applySrvDnsWorkaround();

  client = new MongoClient(env.MONGO_URI);
  await client.connect();
  db = client.db(env.MONGO_DB);
  logger.info({ db: env.MONGO_DB }, "[db] connected");
  return { client, db };
}

function getDb() {
  if (!db) throw new Error("Mongo not connected yet");
  return db;
}

module.exports = { connectMongo, getDb };
