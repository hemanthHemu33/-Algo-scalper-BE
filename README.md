# Kite Scalper Engine (v0.6)

This engine:

- Subscribes to live ticks via Zerodha KiteTicker
- Builds aligned candles (1m/3m etc.)
- Runs multiple scalping strategies
- Places ENTRY + SL + TARGET (OCO) with restart-safe reconciliation

## Subscribe by symbols (recommended)

In `.env`:

```env
SUBSCRIBE_SYMBOLS=RELIANCE
# or:
# SUBSCRIBE_SYMBOLS=NSE:RELIANCE,NSE:TCS
```

Legacy token mode still works:

```env
SUBSCRIBE_TOKENS=738561
```

If both are set, the engine subscribes to the union.

## Included strategies

You control which strategies run using:

```env
STRATEGIES=ema_pullback,vwap_reclaim,orb,bb_squeeze,breakout,volume_spike,fakeout,rsi_fade,wick_reversal
SIGNAL_INTERVALS=1
```

### Strategy list

- `ema_pullback` (trend continuation)
- `vwap_reclaim` (trend continuation / reclaim)
- `orb` (opening range breakout)
- `bb_squeeze` (bollinger squeeze breakout)
- `breakout` (range breakout)
- `volume_spike` (momentum)
- `fakeout` (failed breakout reversal)
- `rsi_fade` (mean reversion)
- `wick_reversal` (exhaustion wick reversal)

## Run

```bash
npm i
npm run sync:instruments   # optional but recommended when using SUBSCRIBE_SYMBOLS
npm run dev
```

Useful endpoints:

- http://localhost:4001/health
- http://localhost:4001/admin/status
- http://localhost:4001/admin/config

## Pro tuning: beating charges (fee-multiple)

This engine has two layers to help you **beat charges**:

1. **Entry-time gate** (planned fee-multiple):

- Computes `plannedProfit @ RR target / estimatedCosts`
- Optional hard gate using `FEE_MULTIPLE_PLANNED_MIN` (0 = disabled)

2. **Post-trade telemetry** (realized fee-multiple):

- On every closed trade, stores:
  - `pnlGrossInr`
  - `estCostsInr`
  - `pnlNetAfterEstCostsInr`
  - `feeMultiple` (= gross / estCosts)
- Aggregates daily stats under `telemetry_trades_daily`

Recommended dynamic-exit safety:

- Don't tighten targets early (kills avg winner size).
- Use **true breakeven**: move SL to entry ± estimated per-share costs (so BE exits aren't fee-negative).

### Key env vars

```env
# True breakeven / trailing (dynamic exits)
DYN_BE_COST_MULT=1.0
DYN_BE_BUFFER_TICKS=1
DYN_TRAIL_START_R=1.0
DYN_ALLOW_TARGET_TIGHTEN=false
DYN_TARGET_TIGHTEN_AFTER_R=1.5

# Planned fee-multiple gate (0 disables)
FEE_MULTIPLE_PLANNED_MIN=0

# Trade telemetry
TELEMETRY_TRADES_ENABLED=true
TELEMETRY_TRADES_DAILY_COLLECTION=telemetry_trades_daily
```

### Trade telemetry endpoints

- `/admin/trade-telemetry/snapshot`
- `/admin/trade-telemetry/flush`
- `/admin/trade-telemetry/daily?dayKey=YYYY-MM-DD`

## Adaptive optimizer (pro step)

This build adds an **adaptive optimizer** that:

- Tracks **feeMultiple = grossPnL / estimated costs** per **symbol × strategy × time-bucket (OPEN/MID/CLOSE)** using the last `OPT_LOOKBACK_N` closed trades.
- **Auto-blocks** a key (symbol×strategy×bucket) when the rolling **avg feeMultiple** falls below `OPT_BLOCK_FEE_MULTIPLE_AVG_MIN` after at least `OPT_MIN_SAMPLES` samples (block lasts `OPT_BLOCK_TTL_MIN` minutes).
- Dynamically **adjusts RR** based on volatility regime using **ATR%**:
  - `atrPct < VOL_ATR_PCT_LOW` → RR_VOL_LOW
  - `VOL_ATR_PCT_LOW..VOL_ATR_PCT_HIGH` → RR_VOL_MED
  - `atrPct > VOL_ATR_PCT_HIGH` → RR_VOL_HIGH
  - Clamped to `RR_MIN..RR_MAX`

### Admin endpoints

All `/admin/*` routes are protected by `ADMIN_API_KEY` in production.

- `GET /admin/optimizer/snapshot` → current optimizer stats + blocked keys
- `POST /admin/optimizer/reload` → reload stats from DB (bootstrap from latest closed trades)
- `POST /admin/optimizer/reset` → clear in-memory optimizer stats

### Key env vars

See `.env.example` for defaults.

<!-- NIFTY 50 COMPLETE LIST  -->

ADANIENT, ADANIPORTS, APOLLOHOSP, ASIANPAINT, AXISBANK, BAJAJ-AUTO, BAJFINANCE, BAJAJFINSV, BEL, BHARTIARTL, CIPLA, COALINDIA, DRREDDY, EICHERMOT, ETERNAL, GRASIM, HCLTECH, HDFCBANK, HDFCLIFE, HEROMOTOCO, HINDALCO, HINDUNILVR, ICICIBANK, INDUSINDBK, INFY, ITC, JIOFIN, JSWSTEEL, KOTAKBANK, LT, M&M, MARUTI, NESTLEIND, NTPC, ONGC, POWERGRID, RELIANCE, SBILIFE, SHRIRAMFIN, SBIN, SUNPHARMA, TCS, TATACONSUM, TATAMOTORS, TATASTEEL, TECHM, TITAN, TRENT, ULTRACEMCO, WIPRO

<!-- NIFTY 50 LIST PRICE BELOW 1K -->

BAJFINANCE,BEL,COALINDIA,ETERNAL,HDFCBANK,HDFCLIFE,HINDALCO,INDUSINDBK,ITC,JIOFIN,KOTAKBANK,NTPC,ONGC,POWERGRID,SHRIRAMFIN,TATAMOTORS,TATASTEEL,WIPRO,ADANIPORTS,ICICIBANK,JSWSTEEL,SBIN

<!-- BANK NIFTY LIST  -->

AUBANK,AXISBANK,BANDHANBNK,FEDERALBNK,HDFCBANK,ICICIBANK,IDFCFIRSTB,INDUSINDBK,KOTAKBANK,PNB,RBLBANK,SBIN

<!-- NIFTY NEXT 50 SYMBOLS -->

ADANIENSOL, ADANIGREEN, ADANIPOWER, AMBUJACEM, BAJAJHFL, BANKBARODA, BPCL, CANBK, CGPOWER, DLF, GAIL, HINDZINC, INDHOTEL, IOC, IRFC, JSWENERGY, LICI, MOTHERSON, PFC, PNB, RECLTD, TATAPOWER, VBL, VEDL, ZYDUSLIFE,PIDILITIND,NAUKRI,UNITDSPR

<!--  -->

ADANIENT, ADANIPORTS, APOLLOHOSP, ASIANPAINT, AXISBANK, BAJAJ-AUTO, BAJAJFINSV, BHARTIARTL, CIPLA, DIVISLAB, DRREDDY, EICHERMOT, GRASIM, HAL, HAVELLS, HCLTECH, HEROMOTOCO, HINDUNILVR, ICICIBANK, INFY, JINDALSTEL, JSWSTEEL, LT, LTIM, M&M, MARUTI, NAUKRI, NESTLEIND, PIDILITIND, RELIANCE, SBILIFE, SBIN, SUNPHARMA, TATACONSUM, TCS, TECHM, TITAN, TRENT, TVSMOTOR, ULTRACEMCO
ALOKINDS, BELRISE, CENTRALBK, CGCL, EASEMYTRIP, ETERNAL, HFCL, IBULHSGFIN, IDBI, IDFCFIRSTB, IEX, IFCI, JMFINANCIL, JPPOWER, NBCC, NETWORK18, NYKAA, OLAELEC, RBLBANK, RPOWER, RTNINDIA, RTNPOWER, SAGILITY, SAMMAANCAP, SJVN, STARHEALTH, SWIGGY, TATAMOTORS, UCOBANK, VMM, WELSPUNLIV, ZEEL

<!-- FINAL LIST  -->

Tier-1 71(best for your current system)

BAJFINANCE, BEL, COALINDIA, HDFCBANK, HDFCLIFE, HINDALCO, INDUSINDBK, ITC, JIOFIN, KOTAKBANK, NTPC, ONGC, POWERGRID, SHRIRAMFIN, TATAMOTORS, TATASTEEL, WIPRO, ADANIPORTS, ICICIBANK, JSWSTEEL, SBIN, AXISBANK, AMBUJACEM, BPCL, CGPOWER, GAIL, HINDZINC, INDHOTEL, IOC, MOTHERSON, PFC, RECLTD, TATAPOWER, VBL, VEDL, ZYDUSLIFE, PIDILITIND, NAUKRI, UNITDSPR, ADANIENT, BAJAJFINSV, BHARTIARTL, CIPLA, DRREDDY, GRASIM, HAL, HAVELLS, HCLTECH, HINDUNILVR, INFY, JINDALSTEL, LT, RELIANCE, SBILIFE, SUNPHARMA, TATACONSUM, TECHM

Tier-2 32(OK, but watch spread/volatility and gap risk)

ETERNAL, AUBANK, BANDHANBNK, FEDERALBNK, IDFCFIRSTB, PNB, RBLBANK, ADANIENSOL, ADANIGREEN, ADANIPOWER, BAJAJHFL, BANKBARODA, CANBK, DLF, IRFC, JSWENERGY, LICI, CENTRALBK, CGCL, HFCL, IBULHSGFIN, IDBI, IEX, NBCC, NYKAA, OLAELEC, SJVN, STARHEALTH, SWIGGY, UCOBANK, ZEEL

Tier-3 (avoid for scalping unless you keep strict gates + only trade when conditions are perfect)

ALOKINDS, BELRISE, EASEMYTRIP, IFCI, JMFINANCIL, JPPOWER, NETWORK18, RPOWER, RTNINDIA, RTNPOWER, SAGILITY, SAMMAANCAP, VMM, WELSPUNLIV

KITE LOGIN API href="https://kite.zerodha.com/connect/login?v=3&api_key=9c2asbtjjrdrwn2z
