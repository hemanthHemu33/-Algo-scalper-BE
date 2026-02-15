# Backtest Gap Status Audit

Date: 2026-02-15

## Status summary

1. **Trade-state latching (`tradePatch`)** — **Fixed**.
2. **Time-stop timestamps (`entryFilledAt`/`createdAt`)** — **Fixed**.
3. **Option trade detection (`isOptionTrade`) inputs** — **Fixed**.
4. **OPT exits using underlying candle** — **Fixed**.
5. **Look-ahead bias via full option candle arrays** — **Fixed**.
6. **Cost model segment inference (EQ vs OPT/FUT)** — **Fixed**.
7. **Partial exits not tracked as remaining position** — **Fixed**.
8. **Latency bars not applied** — **Fixed**.
9. **Phase-3 option universe + historical option candles pipeline** — **Fixed**.
10. **Runner wiring in npm/docs** — **Fixed**.
11. **SL-only parity (target still present in non-OPT path)** — **Partially fixed / pending decision**.
12. **`candles.slice(0, i + 1)` O(n²)** — **Fixed**.

## Notes on pending item

- Item 11 remains policy-dependent: target exits are disabled conditionally for OPT mode via `OPT_TP_ENABLED`, but non-OPT mode still keeps target behavior enabled.
  If strict SL-only parity is required across all modes, add a global toggle and gate target creation/resolution for EQ/FUT too.
