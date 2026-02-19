const { env, subscribeTokens, subscribeSymbols } = require("../src/config");
const { connectMongo } = require("../src/db");
const { readLatestTokenDoc } = require("../src/tokenStore");
const { createKiteConnect } = require("../src/kite/kiteClients");
const { upsertInstrument, parseSymbol } = require("../src/instruments/instrumentRepo");
const { logger } = require("../src/logger");

function getArg(name, fb = null) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fb;
}

async function main() {
  await connectMongo();
  const { accessToken } = await readLatestTokenDoc();
  const kite = createKiteConnect({ apiKey: env.KITE_API_KEY, accessToken });

  const ex = String(getArg("--exchange", env.DEFAULT_EXCHANGE || "NSE")).toUpperCase();
  logger.info({ ex }, "[sync] downloading instruments dump (can be big)");
  const instruments = await kite.getInstruments(ex);
  logger.info({ count: instruments.length }, "[sync] downloaded");

  const wantedTokens = new Set((subscribeTokens || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  const wantedSymbols = new Set((subscribeSymbols || []).map((s) => parseSymbol(s)?.tradingsymbol).filter(Boolean));
  const syncAll = String(getArg("--all", "false")) === "true";
  let cached = 0;

  for (const row of instruments) {
    const tok = Number(row.instrument_token);
    const sym = String(row.tradingsymbol || '').toUpperCase();
    if (!syncAll && !wantedTokens.has(tok) && !wantedSymbols.has(sym)) continue;

    await upsertInstrument({
      instrument_token: tok,
      exchange: row.exchange,
      tradingsymbol: row.tradingsymbol,
      tick_size: Number(row.tick_size ?? 0.05),
      lot_size: Number(row.lot_size ?? 1),
      freeze_qty: Number(row.freeze_qty ?? row.freeze_quantity ?? 0) || null,
      segment: row.segment || null,
      instrument_type: row.instrument_type || null,
      name: row.name || null,
      expiry: row.expiry || null,
      strike: Number(row.strike ?? 0) || null,
    });
    cached++;
  }

  logger.info({ cached, wantedTokens: wantedTokens.size, wantedSymbols: wantedSymbols.size, syncAll, exchange: ex }, "[sync] done");
  process.exit(0);
}

main().catch((e) => {
  logger.error({ e }, "sync failed");
  process.exit(1);
});
