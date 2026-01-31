const { env, subscribeTokens, subscribeSymbols } = require("../src/config");
const { connectMongo } = require("../src/db");
const { readLatestTokenDoc } = require("../src/tokenStore");
const { createKiteConnect } = require("../src/kite/kiteClients");
const { upsertInstrument, parseSymbol } = require("../src/instruments/instrumentRepo");
const { logger } = require("../src/logger");

async function main() {
  await connectMongo();
  const { accessToken } = await readLatestTokenDoc();
  const kite = createKiteConnect({ apiKey: env.KITE_API_KEY, accessToken });

  const ex = env.DEFAULT_EXCHANGE || "NSE";
  logger.info({ ex }, "[sync] downloading instruments dump (can be big)");
  const instruments = await kite.getInstruments(ex);
  logger.info({ count: instruments.length }, "[sync] downloaded");

const wantedTokens = new Set((subscribeTokens || []).map(Number).filter(n => Number.isFinite(n) && n > 0));
const wantedSymbols = new Set((subscribeSymbols || []).map(s => parseSymbol(s)?.tradingsymbol).filter(Boolean));
let cached = 0;

  for (const row of instruments) {
    const tok = Number(row.instrument_token);
    const sym = String(row.tradingsymbol || '').toUpperCase();
    if (!wantedTokens.has(tok) && !wantedSymbols.has(sym)) continue;

    await upsertInstrument({
      instrument_token: tok,
      exchange: row.exchange,
      tradingsymbol: row.tradingsymbol,
      tick_size: Number(row.tick_size || 0.05),
      lot_size: Number(row.lot_size || 1)
    });
    cached++;
  }

  logger.info({ cached, wantedTokens: wantedTokens.size, wantedSymbols: wantedSymbols.size }, "[sync] done");
  process.exit(0);
}

main().catch((e) => {
  logger.error({ e }, "sync failed");
  process.exit(1);
});
