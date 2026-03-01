# Runtime Deep-Dive Audit (SL / BE / Trailing / Min-Green / Order Placement)

Date: 2026-03-01

## Scope

This audit validates runtime behavior and test coverage for:

- Stop-loss lifecycle and protections.
- Breakeven (BE) arming and stop promotion.
- Trailing stop activation and movement constraints.
- Min-green gating and R-based scaling.
- Entry order placement and fill fallback behavior.

## Runtime/Spec Checks Executed

1. `npm run test:jest`
   - Result: **PASS** (16 suites, 48 tests).

2. Focused behavior suites for requested flows:
   - `test/rExitPolicy.dynamicExitManager.test.js`
   - `test/dynamicExit.structureIntegration.test.js`
   - `test/tradeManager.entryMicrostructure.integration.test.js`
   - `test/reentryPolicy.test.js`
   - `test/postFillReconcile.test.js`
   - `test/riskEngine.canTrade.override.test.js`
   - Result: **PASS**.

## What Is Working Correctly

### 1) Min-green logic is active and risk-aware

- Entry min-green calculation includes the maximum of:
  - cost floor,
  - R-based floor,
  - configured absolute INR floor,
  - slip-aware floor.
- Output includes both INR and per-share points for downstream use.
- This is tested in `rExitPolicy.dynamicExitManager.test.js` (`MIN GREEN derived from R with cost floor`).

### 2) BE arming and SL promotion are enforced

- BE arm threshold is derived from scaled risk/cost thresholds and min-green gate.
- When armed, SL is promoted to at least BE floor (+ buffer ticks), with latched state.
- BE and trail latches are persisted through `tradePatch` fields (`beLocked`, `trailLocked` etc.).
- Tests verify BE arm at 0.6R and SL at/above true BE.

### 3) Trailing SL logic is present and disciplined

- Trailing only activates after min-green and arm conditions (`allowTrail` gate).
- ATR-based trail supports regime-specific multipliers (TREND/OPEN/RANGE) and source selection (premium vs underlying-mapped).
- SL movement is monotonic (no loosening), except explicitly bounded early option widening.
- Broker-side validity clamp prevents invalid SL placement beyond market.
- Tests validate trail activation, ATR K selection, and underlying ATR mapping.

### 4) Structure-aware exits integrate with min-green

- Structure anchors are only applied after min-green gate.
- Structure-derived stops are combined with BE/profit-lock/trailing candidates and directional guardrails.
- Integration tests pass (`dynamicExit.structureIntegration.test.js`).

### 5) Order placement flow is robust for entry execution

- Entry logic classifies spreads into PASSIVE / AGGRESSIVE / ABORT policies.
- AGGRESSIVE mode uses IOC laddering with configurable retries and chase caps.
- When enabled and spread is acceptable, it falls back from repeated IOC unmatched to MARKET order.
- Detailed decision/result logging exists per attempt, improving runtime diagnostics.
- Integration tests cover unmatched IOC retries and fallback behavior.

## Identified Issue (Needs Fix)

### BE offset multiplier appears to be applied twice

In `estimateTrueBreakeven()`:

1. `beOffsetInr` already multiplies estimated cost by `mult`.
2. `raw` then again applies `mult * costPerShare`.

This can over-shift BE away from entry (especially for `DYN_BE_COST_MULT > 1`) and may lock profits later than intended.

**Impact**

- BE thresholds and subsequent trailing activation can become more conservative than configured.
- Reported metadata (`beOffsetInr`, `costPerShare`) may not match the final BE move semantics.

**Suggested fix**

- Use `raw = entry +/- costPerShare` (without reapplying `mult`) because `beOffsetInr` already encodes multiplier effects.
- Add a unit test explicitly asserting expected BE shift when `DYN_BE_COST_MULT != 1`.

## Overall Assessment

- Requested runtime areas are largely functional and covered by meaningful tests.
- **Main actionable concern**: BE multiplier double-application in true BE computation.
- No failing automated checks observed in current repository state.
