# DEPLOY IDLE MODE — Discovery Notes (Phase 0)

## Existing Telegram/alert wiring (reuse)
- `src/alerts/telegram.js` already provides Telegram Bot API sender (`sendTelegramMessage`) using native `https`, env-gated by `TELEGRAM_ENABLED`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- `src/alerts/alertService.js` exposes `alert(level, message, meta)` and already forwards to Telegram sender.
- Reuse plan: lifecycle notifications will use `alert(...)` so no duplicate Telegram stack is created.

## Market hours / timezone / gating
- Default timezone is configured to `Asia/Kolkata` in `src/config.js` (`defaultTimezone`).
- `src/market/isMarketOpenNow.js` uses Luxon with `env.CANDLE_TZ || "Asia/Kolkata"`.
- `src/kite/tickerManager.js` uses `MarketGate` to toggle runtime trading enable/disable on market open/close.

## tradingEnabled toggle points
- Runtime toggle source exists in `src/runtime/tradingEnabled.js` (`setTradingEnabled`, `getTradingEnabled`).
- Entry blocking is enforced in `src/trading/tradeManager.js` inside `onSignal(...)` using `getTradingEnabled()`.
- Reuse plan: lifecycle will call `setTradingEnabled(...)` through ticker manager wrapper.

## Session start/stop functions in ticker manager
- Session start path: `setSession(accessToken)`.
- Session teardown path: `teardownActiveSession(reason)`.
- Global shutdown path: `shutdownAll(reason)`.
- Reuse plan: add thin wrappers (`startSession`, `stopSession`, etc.) around existing paths.

## Existing admin endpoints
- Health endpoints: `/health`, `/ready`, `/admin/health/critical` in `src/app.js`.
- Status endpoint: `/admin/status` in `src/app.js`.
- Reuse plan: extend `/admin/status` with lifecycle fields.

## Control points to implement Option A
- Engine heavy components to stop outside market hours: ticker disconnect + pipeline shutdown + reconcile/watchdog/tap loop stop already happen via ticker manager teardown.
- Warmup/live/cooldown orchestration will be added as a scheduler module; startup wiring in `src/index.js` and token hooks in `src/tokenWatcher.js` integration callbacks.
