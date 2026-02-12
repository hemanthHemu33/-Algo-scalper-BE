# Render deployment + Telegram alerts

## 1) Render service (Web Service)
- Build Command: `npm ci`
- Start Command: `npm start`
- Health check path: `/ready` (returns **200** only if ticker is connected and trading is not halted)

## 2) Required environment variables
### Mongo
- `MONGO_URI`
- `MONGO_DB`

### Zerodha Kite
- `KITE_API_KEY`
- Your token watcher envs (whatever you already use):
  - `KITE_TOKEN_COLLECTION` (default: `kite_tokens`)
  - (If you use any other token fields in DB, keep them as-is)

### Subscribe (single stock)
- `SUBSCRIBE_SYMBOLS` = `NSE:RELIANCE` (or just `RELIANCE` if `DEFAULT_EXCHANGE=NSE`)
- Leave `SUBSCRIBE_TOKENS` empty if you only want symbols.

### Trading
- `TRADING_ENABLED=false` initially (paper mode)
- When ready to go live: `TRADING_ENABLED=true`
- `DEFAULT_PRODUCT=MIS`
- `DEFAULT_ORDER_VARIETY=regular`
- Risk controls:
  - `MAX_TRADES_PER_DAY=8`
  - `MAX_OPEN_POSITIONS=1`
  - `SYMBOL_COOLDOWN_MIN=10`
  - `DAILY_MAX_LOSS=1000`
  - `AUTO_EXIT_ON_DAILY_LOSS=true`
  - `MAX_CONSECUTIVE_FAILURES=3`
- Time guards:
  - `STOP_NEW_ENTRIES_AFTER=15:00`
  - `FORCE_FLATTEN_AT=15:15`

## 3) Telegram alerts
- `TELEGRAM_ENABLED=true`
- `TELEGRAM_BOT_TOKEN=<bot token>`
- `TELEGRAM_CHAT_ID=<chat id>`
- Optional: `TELEGRAM_MIN_LEVEL=info` (or `warn` / `error`)

The bot will send alerts for:
- Startup + token updates
- Ticker connect/disconnect/errors
- Entry/SL/Target placement + fills
- Rejections / guard fails / kill switch / panic exits
- Recovery issues on restart (open position found)

## 4) Deploy checklist
1. Deploy with `TRADING_ENABLED=false`
2. Verify:
   - `/health` is ok
   - `/ready` becomes ok after ticker connects
   - Telegram messages are received
3. Turn on `TRADING_ENABLED=true` during market hours only.
4. During the first live sessions (and before any restart), verify no legacy trade statuses are stuck:
   ```bash
   curl -H "x-api-key: $ADMIN_API_KEY" \
     "http://localhost:4001/admin/trades/legacy-statuses?sinceHours=24&limit=300"
   ```
   Expect `hasLegacyStatuses=false`.
5. Start with 1 stock and small sizing.

> ⚠️ Render free tier can sleep. Use a plan that stays awake for real trading.
