# Backtesting Runbook — `kite-scalper-engine` (v1.3 FNO back-test)

This file is an end‑to‑end **runbook** for doing **repeatable backtests** inside this repo:
- **EQ mode** (underlying candles replay) — best for validating **signal + exit behavior** without option‑expiry complications.
- **OPT mode** (options premium replay with dynamic contract selection) — closer to live execution, but requires **option candle data** and has expiry/token caveats.

> **Timezone assumed:** Asia/Kolkata (IST)  
> **Shell assumed:** Windows PowerShell  
> **MongoDB assumed:** reachable via `MONGO_URI`

---

## 0) What this backtest engine does (mental model)

For each candle in the range:

1. Loads candles from MongoDB collection `candles_<interval>m`.
2. Runs strategy evaluation and signal selection.
3. Opens a single position (max 1 open trade at a time in the backtest loop).
4. Manages the trade candle‑by‑candle using SL/TP + dynamic exit rules (if enabled).
5. Closes by SL/TP, exitNow, or end‑of‑day forced flatten.
6. Writes results to:
   - `bt_runs` collection (Mongo) and/or
   - `--out` JSON file on disk.

### Important limitations (expected behavior)
- **Single open position** only.
- **Candle‑based (OHLC)** — not tick‑based.
- If SL and TP both touch in the same candle, the engine assumes **SL first** (conservative).
- OPT mode without archived expiries may select **expiries available in today’s instruments dump**, not historical weekly expiries.

---

## 1) Prerequisites (must have)

### 1.1 Node + dependencies
From repo root:

```powershell
npm i
```

### 1.2 MongoDB access
- `MONGO_URI` must point to your MongoDB/Atlas.
- Recommended: use a **separate database** for backtests so TTL/live jobs don’t interfere.

### 1.3 Kite access token available in Mongo
Your historical backfill scripts read the token doc from Mongo via `TOKENS_COLLECTION`.

✅ Recommended structure:
- Live DB: `scanner_app` (contains token doc)
- Backtest DB: `scanner_app_bt` (contains backtest candles + runs)

---

## 2) One-time .env configuration (recommended)

Add / update these keys in `.env`:

```env
# Use separate backtest DB for candles/runs
MONGO_DB=scanner_app_bt

# Token DB override (token doc lives in scanner_app)
TOKENS_DB=scanner_app
TOKENS_COLLECTION=broker_tokens   # set to your actual collection name

# Backtest must allow historical candles to generate signals
ALLOW_SYNTHETIC_SIGNALS=true

# Use IST candle timezone
CANDLE_TZ=Asia/Kolkata

# Intervals you will backtest (must include your CLI --interval)
SIGNAL_INTERVALS=1

# Disable TTL in backtest DB so older candles aren’t deleted
CANDLE_TTL_ENABLED=false
```

### 2.1 Quick token health check (safe)
This prints only whether the token exists (no secrets):

```powershell
node -e "const {connectMongo}=require('./src/db'); const {readLatestTokenDoc}=require('./src/tokenStore'); connectMongo().then(()=>readLatestTokenDoc()).then(r=>console.log({hasToken:!!r.accessToken, reason:r.reason, tokensDb:r.tokensDb, collection:r.collection})).catch(e=>console.error(e));"
```

Expected:
```text
{ hasToken: true, ... }
```

If `hasToken:false`:
- verify `TOKENS_COLLECTION`
- verify the doc contains `access_token` (or the supported alias)

---

## 3) Step-by-step workflow (3–6 months backtest)

> **Token note:** examples use `--token=256265` (NIFTY 50 index token in your setup).  
> Replace with your own token if needed.

---

### Step A — Backfill UNDERLYING candles (mandatory for both EQ & OPT)

#### A.1 Backfill 1-minute candles for a long range
Example: **3 months** (Dec 01, 2025 → Mar 03, 2026)

```powershell
npm run bt:backfill -- --token=256265 --from=2025-12-01T00:00:00+05:30 --to=2026-03-03T23:59:59+05:30 --interval=1 --chunkDays=10
```

✅ Expected output (pattern)
- multiple chunks:
  - `[bt_backfill] fetching ...`
  - `[bt_backfill] inserted/upserted XXXX (total YYYY)`
- final:
  - `[bt_backfill] done. token=256265 now has ZZZZ candles in candles_1m`

If you see:
- `No Kite access token found...` → fix token DB/collection (Section 2.1)

---

### Step B — Verify candles exist for the requested range (mandatory)

```powershell
node scripts/bt_debug_candles.js --token=256265 --interval=1 --from=2025-12-01 --to=2026-03-03T23:59:59+05:30 --limit=3
```

✅ Expected:
- `rangeCount > 0`
- `minTs` and `maxTs` match your date range

If `rangeCount=0`, your backfill isn’t in that window.

---

### Step C — Run EQ backtest first (recommended baseline)

EQ backtest validates **signal quality + exits** without option‑expiry issues.

```powershell
npm run bt:run -- --mode=EQ --token=256265 --from=2025-12-01 --to=2026-03-03T23:59:59+05:30 --interval=1 --limit=400000 --qty=1 --execRealism=true --eventBroker=true --forceEodExit=true --dataQuality=warn --out=bt_eq_3mo.json
```

✅ Expected behavior
- Calendar loads:
  - `[calendar] loaded ... market_calendar.json`
- If any data quality issues exist, you’ll see:
  - `[bt_run] data quality guardrails warnings { ... }`
- Completion:
  - `Backtest complete: ... bt_eq_3mo.json`
  - JSON summary printed (trades, wins, pnl, DD…)

**If it fails with strict validation**, use:
- `--dataQuality=warn` (inspect and continue) or
- `--dataQuality=off` (force run)

---

### Step D — Inspect EQ results (must-do)

#### D.1 Exit breakdown (SL vs TP vs EOD vs other)
```powershell
node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('bt_eq_3mo.json','utf8')); const trades=r.trades||[]; let sl=0,tp=0,eod=0,other=0; for(const t of trades){const er=(t.exitReason||t.exit?.reason||'').toUpperCase(); if(er.includes('STOP')) sl++; else if(er.includes('TAKE')||er.includes('TP')) tp++; else if(er.includes('EOD')) eod++; else other++;} console.log({trades:trades.length, SL:sl, TP:tp, EOD:eod, other});"
```

#### D.2 Per‑strategy performance (find “bleeders”)
```powershell
node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('bt_eq_3mo.json','utf8')); const ps=r.analytics?.perStrategy||{}; const rows=Object.entries(ps).map(([k,v])=>({strategy:k,trades:v.trades||0,net:(v.totalNetPnl??v.netPnl??0),winRate:(v.winRate??0)})).sort((a,b)=>a.net-b.net); console.table(rows);"
```

✅ Expected behavior
- You can identify which strategies are negative contributors.
- You can tune **strategy list** or **confidence** based on evidence.

---

## 4) OPT mode workflow (options premium replay)

OPT mode requires **option token selection + option candle backfill**.

> ⚠️ **Expiry caveat:** if you do not have archived historical NFO instruments, the script uses the current Kite dump and may choose expiries not matching “true historical weekly expiry”.

---

### Step E — Prepare option universe + option candles

Do this **month-by-month** for reliability and speed.

Example window: Feb 05 → Feb 28:

```powershell
npm run bt:prepare-options -- --underlyingToken=256265 --underlying="NIFTY 50" --optionType=CE --from=2026-02-05 --to=2026-02-28 --interval=1 --refreshInstruments=true
```

✅ Expected behavior
- Shows underlying candle availability:
  - `[bt_prepare_options] underlying token=... total=... minTs=... maxTs=...`
- Shows NFO dump stats:
  - `nfoRows=...`
  - `filterCounts ...`
- Per-day selection lines:
  - `[YYYY-MM-DD] expiry=YYYY-MM-DD spot=... atm=... tokens=5`
- Backfilled option candles:
  - `backfilled token=XXXXXXXX candles=YYYY`
- Final:
  - `Done. selectedTokens=... insertedCandles=...`

If you see `invalid token`:
- token is expired/stale → ensure selection is using fresh dump (your patched script does)
- rerun with `--refreshInstruments=true`

---

### Step F — Run OPT backtest (after prepare-options)

Example: Feb 05 → Feb 28

```powershell
npm run bt:run -- --mode=OPT --token=256265 --underlying="NIFTY 50" --dynamicContracts=true --optionType=CE --from=2026-02-05 --to=2026-02-28T23:59:59+05:30 --interval=1 --limit=400000 --qty=50 --execRealism=true --eventBroker=true --forceEodExit=true --dataQuality=warn --out=bt_opt_feb2026.json
```

✅ Expected behavior
- Similar to EQ run; output json is created.
- Trade count may be lower/higher depending on contract availability and option filters.

---

## 5) Expected outputs (what “success” looks like)

### 5.1 Backfill script (`bt:backfill`)
- Inserts candles in chunks
- Final count increases
- `done. token=... now has ... candles`

### 5.2 Debug script (`bt_debug_candles.js`)
- `rangeCount` should be > 0 and ideally equals token total for that window

### 5.3 Prepare options (`bt:prepare-options`)
- `selectedTokens > 0`
- `insertedCandles > 0`
- “backfilled token=... candles=...” repeated

### 5.4 Run (`bt:run`)
- prints calendar loaded
- finishes with “Backtest complete: …”
- prints summary:
  - trades, wins, losses, winRate
  - totalNetPnl
  - totalEstimatedCostInr
  - maxDrawdownInr
  - avgNetPerTrade

---

## 6) Common failure modes & exact fixes

### 6.1 `No candles found for query`
Cause:
- candles not present in DB/collection/interval
Fix:
1) verify `MONGO_DB` is correct
2) verify `CANDLE_COLLECTION_PREFIX` (default `candles_`)
3) run `bt_debug_candles.js` to confirm `rangeCount`

---

### 6.2 `No Kite access token found in token store`
Cause:
- token doc not found in backtest DB (or wrong collection)
Fix:
- set `TOKENS_DB=scanner_app` (where token doc exists)
- set `TOKENS_COLLECTION=...` correctly
- run token health check (Section 2.1)

---

### 6.3 `No NFO instruments matched filter; skipping instrument cache sync`
Cause:
- filter too tight / expiry parsing / wrong root
Fix:
- rerun with `--refreshInstruments=true`
- confirm output `nfoRows > 0`, `byRoot > 0`
- ensure underlying name/root is NIFTY (`underlying="NIFTY 50"` is OK)

---

### 6.4 `invalid token` during option candle backfill
Cause:
- stale/expired tokens selected from old cache
Fix:
- use fresh selection: `--refreshInstruments=true`
- your patched scripts skip invalid tokens; still, prefer fresh list

---

### 6.5 Data quality strict failure
Example:
- `Data quality validation failed (NN issues)`
Fix:
- use `--dataQuality=warn` to inspect and continue
- or `--dataQuality=off` to force

Common issues:
- session boundary candles outside 09:15–15:30
- gaps (missing minutes)

---

## 7) Recommendations for reliable evaluation

### 7.1 Always start with EQ baseline
- EQ tells you if your signal+exit combination has an “edge” directionally.
- OPT tells you how much friction + premium dynamics change outcomes.

### 7.2 Backtest month-by-month in OPT
- reduces token/expiry confusion
- faster debugging

### 7.3 Archive instruments daily (for future accurate OPT backtests)
If you want “true historical expiry” backtests, you should store daily NFO dump snapshots going forward.

---

## 8) Minimal “Quick Start” (copy/paste)

1) Configure `.env` (Section 2)  
2) Backfill candles:
```powershell
npm run bt:backfill -- --token=256265 --from=2025-12-01T00:00:00+05:30 --to=2026-03-03T23:59:59+05:30 --interval=1 --chunkDays=10
```
3) Verify:
```powershell
node scripts/bt_debug_candles.js --token=256265 --interval=1 --from=2025-12-01 --to=2026-03-03T23:59:59+05:30 --limit=3
```
4) Run EQ:
```powershell
npm run bt:run -- --mode=EQ --token=256265 --from=2025-12-01 --to=2026-03-03T23:59:59+05:30 --interval=1 --limit=400000 --qty=1 --execRealism=true --eventBroker=true --forceEodExit=true --dataQuality=warn --out=bt_eq_3mo.json
```
5) (Optional) Run OPT month:
```powershell
npm run bt:prepare-options -- --underlyingToken=256265 --underlying="NIFTY 50" --optionType=CE --from=2026-02-01 --to=2026-02-28 --interval=1 --refreshInstruments=true
npm run bt:run -- --mode=OPT --token=256265 --underlying="NIFTY 50" --dynamicContracts=true --optionType=CE --from=2026-02-01 --to=2026-02-28T23:59:59+05:30 --interval=1 --limit=400000 --qty=50 --execRealism=true --eventBroker=true --forceEodExit=true --dataQuality=warn --out=bt_opt_feb2026.json
```

---

## 9) Where results live

- JSON output: the file specified by `--out`
  - example: `bt_eq_3mo.json`, `bt_opt_feb2026.json`
- MongoDB:
  - `candles_1m` (and other intervals)
  - `bt_runs` (run summaries and/or run payloads)
  - `instruments_cache` (instrument metadata; used in OPT selection)

---

## 10) Checklist before trusting results

- [ ] `rangeCount` equals expected candles for the period  
- [ ] OPT: `selectedTokens > 0`, `insertedCandles > 0`  
- [ ] Data quality warnings are understood (gaps/sessionBoundary)  
- [ ] Exit breakdown isn’t dominated by STOPLOSS (unless that is intended)  
- [ ] Compare month-by-month, not just one window  

---

**End of runbook.**
