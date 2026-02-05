# API Endpoints Reference (from `buildApp()`)

This document lists **all API endpoints present in the pasted `buildApp()` file**, with **sample responses** you can use for dashboards and testing.

> Note: Sample payloads include **representative** fields based on your code usage. Actual shapes may differ depending on your runtime modules (`pipeline.status()`, `telemetry`, `optimizer`, etc.).

---

## Base

- JSON body parser enabled: `express.json({ limit: "256kb" })`
- All admin endpoints are under: `/admin/*`

---

## Kite login

These endpoints complete Zerodha Kite Connect login by exchanging the `request_token` for an `access_token` on the server, then storing it into MongoDB.

### Required env vars

- `KITE_API_KEY` (already present)
- `KITE_API_SECRET` (new) — required to generate a session. **Never expose this in FE.**
- `TOKENS_COLLECTION` — set to `tokens` (as you requested).

Optional:

- `KITE_REDIRECT_SUCCESS_URL` — after successful login, the browser is redirected here (e.g., your FE dashboard URL).
- `KITE_ALLOWED_USER_ID` — safety guard to prevent a different Kite account overwriting your token doc.

### GET /kite-redirect

Kite should redirect the user here after login (configure this in your Kite app settings as your **redirect_url**).

**Query params**

- `request_token` (required)

**Responses**

- `200` (text): login successful
- `302` (redirect): if `KITE_REDIRECT_SUCCESS_URL` is set
- `400/500`: JSON error

Example:

`/kite-redirect?request_token=...`

### POST /admin/kite/session

If you keep Kite `redirect_url` pointing to the FE, the FE can POST the `request_token` here to finish login.

**Body**

```json
{ "request_token": "..." }
```

**Response**

```json
{ "ok": true, "user_id": "...", "api_key": "..." }
```

---

## Admin authentication

Admin auth is applied to **all** `/admin/*` endpoints:

```js
app.use("/admin", buildAdminAuth());
```

### How auth behaves

- **Production (`NODE_ENV=production`)**
  - If `ADMIN_API_KEY` is **missing** → all `/admin/*` return **503**
  - If `ADMIN_API_KEY` is set → require key via:
    - `x-api-key: <ADMIN_API_KEY>` **or**
    - `Authorization: Bearer <ADMIN_API_KEY>`

- **Development**
  - If `ADMIN_API_KEY` is missing → admin is **open** (no auth)
  - If `ADMIN_API_KEY` is set → same auth rules as prod

### Admin auth error responses

**401 unauthorized**

```json
{ "ok": false, "error": "unauthorized" }
```

**503 key not configured (prod only)**

```json
{ "ok": false, "error": "ADMIN_API_KEY not configured" }
```

---

## Public endpoints

### `GET /health`

**Purpose:** Basic liveness.

**200**

```json
{
  "ok": true,
  "ts": 1737950000000
}
```

---

### `GET /ready`

**Purpose:** Readiness check: pipeline exists + ticker connected + not halted.

**200 (ready)**

```json
{
  "ok": true,
  "halted": false,
  "haltInfo": null,
  "ticker": {
    "connected": true,
    "lastDisconnect": null,
    "hasSession": true
  },
  "now": "2026-01-27T10:00:00.000Z"
}
```

**503 (not ready / exception)**

```json
{
  "ok": false,
  "error": "some error message"
}
```

---

## Admin endpoints

### `GET /admin/config`

**Purpose:** Runtime config snapshot (sanitized).

**200**

```json
{
  "tradingEnabled": true,
  "tradingEnabledSource": "runtime",
  "tradingEnabledEnv": "false",
  "tokensCollection": "tokens",
  "tokenFilters": {
    "user_id": null,
    "api_key": null,
    "tokenField": "access_token"
  },
  "subscribeTokens": "",
  "subscribeSymbols": "BHARATCOAL,AXISBANK",
  "candleIntervals": [1, 3],
  "strategyId": "rsi_fade",
  "strategies": ["rsi_fade", "vwap_reclaim"],
  "signalIntervals": [1, 3],
  "reconcileIntervalSec": 15
}
```

---

### `GET /admin/trading`

**Purpose:** Fetch current trading enablement (runtime override or env default).

**200**

```json
{
  "ok": true,
  "tradingEnabled": true,
  "source": "runtime"
}
```

---

### `POST /admin/trading?enabled=true|false`

**Purpose:** Enable/disable trading at runtime (overrides env until restart).

**200**

```json
{
  "ok": true,
  "enabled": false,
  "source": "runtime"
}
```

---

### `GET /admin/status`

**Purpose:** Overall status (pipeline + ticker + halt info).

**200**

```json
{
  "ok": true,
  "tradingEnabled": true,
  "tradingEnabledSource": "runtime",
  "killSwitch": false,
  "tradesToday": 0,
  "activeTradeId": null,
  "activeTrade": null,
  "recoveredPosition": null,
  "dailyRisk": {
    "_id": "696da8ad7e30538bd1e70676",
    "date": "2026-01-27",
    "createdAt": "2026-01-27T03:44:45.389Z",
    "kill": false,
    "ordersPlaced": 0,
    "realizedPnl": 0,
    "reason": null,
    "updatedAt": "2026-01-27T03:44:45.389Z"
  },
  "ordersPlacedToday": 0,
  "halted": false,
  "haltInfo": null,
  "ticker": {
    "connected": true,
    "lastDisconnect": null,
    "hasSession": true
  },
  "now": "2026-01-27T10:00:00.000Z"
}
```

**503**

```json
{ "ok": false, "error": "some error message" }
```

---

## Market calendar endpoints

⚠️ **Important implementation note (bug):** In your pasted code, the routes below are defined **inside** the `/admin/status` handler block. That means:

- They may not be registered until `/admin/status` is called at least once.
- They may be registered repeatedly on every `/admin/status` request (memory leak / unexpected behavior).

You should move these route definitions **outside** `/admin/status`.

### `GET /admin/market/calendar`

**Purpose:** Market calendar diagnostics.

**200**

```json
{
  "ok": true,
  "meta": {
    "tz": "Asia/Kolkata",
    "source": "local_or_remote",
    "lastLoadedAt": "2026-01-27T09:30:00.000Z",
    "today": {
      "date": "2026-01-27",
      "isTradingDay": true,
      "open": "09:15",
      "close": "15:30"
    }
  }
}
```

---

### `POST /admin/market/calendar/reload`

**Purpose:** Reload market calendar.

**200**

```json
{
  "ok": true,
  "meta": {
    "tz": "Asia/Kolkata",
    "source": "reloaded",
    "lastLoadedAt": "2026-01-27T10:01:12.000Z"
  }
}
```

---

## Cost calibration endpoints (PATCH-6)

### `GET /admin/cost/calibration`

**Purpose:** Cost calibrator snapshot + recent reconciliation runs.

**200**

```json
{
  "ok": true,
  "calibration": {
    "enabled": true,
    "version": 1,
    "updatedAt": "2026-01-27T09:00:00.000Z",
    "segments": {
      "NSE": { "bps": 8.5 },
      "NFO-OPT": { "bps": 35.0 },
      "NFO-FUT": { "bps": 18.0 }
    }
  },
  "recentRuns": [
    {
      "ts": "2026-01-27T09:05:00.000Z",
      "source": "contract_note",
      "count": 12,
      "status": "ok"
    }
  ]
}
```

**500**

```json
{ "ok": false, "error": "some error message" }
```

---

### `POST /admin/cost/calibration/reload`

**Purpose:** Reload calibrator config from DB.

**200**

```json
{
  "ok": true,
  "result": { "loaded": true, "updatedAt": "2026-01-27T10:02:00.000Z" },
  "calibration": {
    "enabled": true,
    "version": 2,
    "updatedAt": "2026-01-27T10:02:00.000Z"
  }
}
```

**500**

```json
{ "ok": false, "error": "some error message" }
```

---

## Subscription endpoints

### `GET /admin/subscriptions`

**Purpose:** Return current subscribed tokens (from `tickerManager`).

**200**

```json
{
  "ok": true,
  "count": 3,
  "tokens": [194561, 260105, 738561]
}
```

**503**

```json
{ "ok": false, "error": "some error message" }
```

---

## DB retention (TTL) endpoints (PATCH-9)

### `GET /admin/db/retention`

**Purpose:** Show retention/TTL configuration.

**200**

```json
{
  "ok": true,
  "tz": "Asia/Kolkata",
  "collections": [
    {
      "name": "aligned_ticks",
      "ttl": { "field": "ts", "seconds": 86400 },
      "indexes": [{ "name": "ts_ttl", "key": { "ts": 1 } }]
    }
  ]
}
```

**500**

```json
{ "ok": false, "error": "some error message" }
```

---

### `POST /admin/db/retention/ensure`

**Purpose:** Ensure TTL indexes exist.

**200**

```json
{
  "ok": true,
  "result": {
    "created": ["aligned_ticks.ts_ttl"],
    "skipped": ["telemetry_signals_daily.dayKey_idx"]
  },
  "after": {
    "ok": true,
    "collections": [
      { "name": "aligned_ticks", "ttl": { "field": "ts", "seconds": 86400 } }
    ]
  }
}
```

**500**

```json
{ "ok": false, "error": "some error message" }
```

---

## DB purge endpoint

**Danger:** Deletes documents from all collections except a keep list. Requires `DB_PURGE_ENABLED=true` and `confirm: "PURGE"`.

### `POST /admin/db/purge`

**Body**

```json
{
  "confirm": "PURGE",
  "keepCollections": ["audit_logs", "broker_tokens"],
  "dryRun": true
}
```

**200**

```json
{
  "ok": true,
  "dryRun": true,
  "keepCollections": ["audit_logs", "broker_tokens"],
  "results": [
    { "collection": "candles_1m", "deletedCount": 0, "count": 12345 },
    { "collection": "trades", "deletedCount": 0, "count": 78 }
  ]
}
```

**400/403/500**

```json
{ "ok": false, "error": "confirm_required | purge_disabled | some error message" }
```

---

## F&O universe snapshot

### `GET /admin/fno`

**Purpose:** Snapshot of last derivatives universe (FUT or OPT).

**200 (universe available)**

```json
{
  "ok": true,
  "enabled": true,
  "universe": {
    "mode": "OPT",
    "underlyings": ["NIFTY", "BANKNIFTY"],
    "contracts": {
      "NIFTY": {
        "exchange": "NFO",
        "segment": "NFO-OPT",
        "expiry": "2026-01-29",
        "lot_size": 65,
        "tick_size": 0.05
      }
    }
  }
}
```

**200 (no universe yet)**

```json
{
  "ok": true,
  "enabled": false,
  "universe": null
}
```

**503**

```json
{ "ok": false, "error": "some error message" }
```

---

## Kill switch / halt controls

### `POST /admin/kill`

**Body**

```json
{ "enabled": true }
```

**200**

```json
{ "ok": true, "kill": true }
```

**503**

```json
{ "ok": false, "error": "some error message" }
```

---

### `POST /admin/halt/reset`

**Purpose:** Reset runtime HALT flag (does not toggle kill-switch).

**200**

```json
{ "ok": true, "halted": false, "haltInfo": null }
```

**503**

```json
{ "ok": false, "error": "some error message" }
```

---

## Trades

### `GET /admin/trades/recent?limit=10`

**Purpose:** Return latest trades from DB (default limit=10, capped at 50).

**200**

```json
{
  "ok": true,
  "rows": [
    {
      "_id": "65b4...",
      "symbol": "NIFTY",
      "side": "BUY",
      "qty": 65,
      "entry": 220.5,
      "sl": 215.0,
      "target": 232.0,
      "status": "OPEN",
      "createdAt": "2026-01-27T09:45:00.000Z"
    }
  ]
}
```

**503**

```json
{ "ok": false, "error": "some error message" }
```

---

## Signal telemetry endpoints

### `GET /admin/telemetry/snapshot`

**200**

```json
{
  "ok": true,
  "data": {
    "dayKey": "2026-01-27",
    "tz": "Asia/Kolkata",
    "received": 120,
    "blockedTotal": 95,
    "dispatched": 25
  }
}
```

---

### `POST /admin/telemetry/flush`

**Purpose:** Persist telemetry snapshot to DB.

**200**

```json
{
  "ok": true,
  "written": true,
  "dayKey": "2026-01-27",
  "updatedAt": "2026-01-27T10:05:00.000Z"
}
```

**503**

```json
{ "ok": false, "error": "some error message" }
```

---

### `GET /admin/telemetry/daily?dayKey=2026-01-27`

**Purpose:** Read telemetry daily doc from DB.

**200**

```json
{
  "ok": true,
  "dayKey": "2026-01-27",
  "doc": {
    "dayKey": "2026-01-27",
    "tz": "Asia/Kolkata",
    "blockedTotal": 95,
    "blockedBySymbol": { "194561": 40 },
    "blockedBySymbolStrategyBucketReason": {
      "194561": {
        "rsi_fade": {
          "OPEN": { "STYLE_REGIME_MISMATCH": 12 }
        }
      }
    }
  }
}
```

**503**

```json
{ "ok": false, "error": "some error message" }
```

---

## Trade telemetry endpoints

### `GET /admin/trade-telemetry/snapshot`

**200**

```json
{
  "ok": true,
  "data": {
    "dayKey": "2026-01-27",
    "placed": 6,
    "estimatedCostsInr": 420.5,
    "realizedPnlInr": 610.0
  }
}
```

---

### `POST /admin/trade-telemetry/flush`

**200**

```json
{
  "ok": true,
  "written": true,
  "dayKey": "2026-01-27",
  "updatedAt": "2026-01-27T10:10:00.000Z"
}
```

**503**

```json
{ "ok": false, "error": "some error message" }
```

---

### `GET /admin/trade-telemetry/daily?dayKey=2026-01-27`

**200**

```json
{
  "ok": true,
  "dayKey": "2026-01-27",
  "doc": {
    "dayKey": "2026-01-27",
    "feeMultiple": 1.4,
    "trades": [
      { "tradeId": "T1", "edgeInr": 210, "costInr": 60, "pnlInr": 180 }
    ]
  }
}
```

**503**

```json
{ "ok": false, "error": "some error message" }
```

---

## Optimizer endpoints

### `GET /admin/optimizer/snapshot`

**200**

```json
{
  "ok": true,
  "data": {
    "feeMultiple": 1.35,
    "updatedAt": "2026-01-27T09:50:00.000Z",
    "stats": { "wins": 3, "losses": 2 }
  }
}
```

**503**

```json
{ "ok": false, "error": "some error message" }
```

---

### `GET /admin/optimizer` (alias)

**200**

```json
{
  "ok": true,
  "data": {
    "feeMultiple": 1.35,
    "updatedAt": "2026-01-27T09:50:00.000Z"
  }
}
```

---

### `POST /admin/optimizer/flush`

**Purpose:** Persist optimizer state.

**200**

```json
{
  "ok": true,
  "written": true,
  "updatedAt": "2026-01-27T10:12:00.000Z"
}
```

---

### `POST /admin/optimizer/reload`

**Purpose:** Reload optimizer state from DB.

**200**

```json
{
  "ok": true,
  "loaded": true,
  "data": { "feeMultiple": 1.3 }
}
```

---

### `POST /admin/optimizer/reset`

**Purpose:** Reset optimizer to defaults.

**200**

```json
{ "ok": true }
```

---

## Rejections / blocks analytics

### `GET /admin/rejections`

**Query params**

- `top` (optional, number)
- `dayKey` (optional, `YYYY-MM-DD`)
  - If provided → reads daily doc from DB
  - If missing → uses in-memory snapshot

**200 (memory source)**

```json
{
  "ok": true,
  "source": "memory",
  "data": {
    "top": 50,
    "bySymbol": [{ "key": "194561", "count": 40 }],
    "byReason": [{ "key": "STYLE_REGIME_MISMATCH", "count": 25 }]
  }
}
```

**200 (db source)**

```json
{
  "ok": true,
  "source": "db",
  "dayKey": "2026-01-27",
  "tz": "Asia/Kolkata",
  "updatedAt": "2026-01-27T10:00:00.000Z",
  "blockedTotal": 95,
  "top": {
    "bySymbol": [{ "key": "194561", "count": 40 }],
    "bySymbolStrategyBucketReason": [
      {
        "symbol": "194561",
        "strategyId": "rsi_fade",
        "bucket": "OPEN",
        "reasonKey": "STYLE_REGIME_MISMATCH",
        "count": 12
      }
    ]
  }
}
```

**404 (dayKey not found)**

```json
{
  "ok": false,
  "error": "day_not_found",
  "dayKey": "2026-01-10"
}
```

**503 (other errors)**

```json
{ "ok": false, "error": "some error message" }
```

---

## Quick curl examples

### Health

```bash
curl http://localhost:4001/health
```

### Ready

```bash
curl http://localhost:4001/ready
```

### Admin with x-api-key

```bash
curl -H "x-api-key: $ADMIN_API_KEY" http://localhost:4001/admin/status
```

### Admin with bearer token

```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" http://localhost:4001/admin/config
```

---

## Pro dashboard extensions

These endpoints support the pro dashboard features (equity, positions, OMS, risk, telemetry, execution quality, market health, audit logs, alerting, RBAC).

### `GET /admin/account/equity`

Returns the latest equity snapshot and a rolling equity curve.

### `GET /admin/positions`

Returns live positions with average price, P&L, exposure, and per-position risk (when available).

### `GET /admin/orders`

Returns current order list with lifecycle status.

### `GET /admin/orders/history?orderId=...`

Returns broker order history for a given order.

### `GET /admin/orders/logs?orderId=...&tradeId=...&limit=...`

Returns order update logs persisted by the OMS.

### `GET /admin/risk/limits`

Returns portfolio-level risk limits plus current exposure usage.

### `POST /admin/risk/limits`

Updates risk limits (admin-only).

### `GET /admin/strategy/kpis`

Returns strategy-level KPIs (win rate, expectancy, Sharpe, max drawdown, average hold time).

### `GET /admin/execution/quality`

Returns execution quality stats (slippage vs. signal price, fill rate, rejection reasons).

### `GET /admin/market/health`

Returns market data health (feed lag by symbol and data-gap metrics).

### `GET /admin/audit/logs`

Returns audit & compliance logs for admin actions.

### `GET /admin/alerts/channels`

List alerting channels.

### `POST /admin/alerts/channels`

Add alerting channels (webhook/email/SMS stubs).

### `DELETE /admin/alerts/channels/:id`

Remove alerting channel.

### `GET /admin/alerts/incidents`

List recent alert incidents.

### `POST /admin/alerts/test`

Send a test notification.

### `GET /admin/rbac`

Returns RBAC configuration (roles/permissions).
