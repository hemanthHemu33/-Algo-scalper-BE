const { MongoClient } = require("mongodb");
const { env } = require("./config");
const { logger } = require("./logger");

let client;
let db;

async function connectMongo() {
  if (db) return { client, db };
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
