# PATCH NOTES — Live Robustness Wiring Fixes

## Root cause
- `evaluateDailyRiskState` existed in `src/risk/riskLimits.js` but was not imported in `TradeManager`, causing runtime `is not defined` errors in live loops.
- Multiple raw `setInterval` loops across ticker/trade lifecycle could be started more than once under reconnect/reinit paths.
- Broker WS subscriptions were re-issued without strict dedupe, allowing token subscription amplification on reconnect/runtime adds.

## What changed
- Added a shared `intervalRegistry` to enforce singleton interval names and expose interval telemetry (`ms`, `createdAt`, `lastRunTs`, `runCount`).
- Wired `TradeManager` daily risk evaluation through safe wrapper with throttled error logging and fail-closed entry gating (`DAILY_RISK_UNAVAILABLE`) while preserving exit management loops.
- Added boot identity telemetry (`instanceId`, `pid`, `bootTs`) and surfaced timer/risk/ws/ticktap metrics through status payloads.
- Added token subscription dedupe in ticker subscription path and reconnect re-subscribe normalization.

## How timer registry prevents duplicates
- Interval start uses a global map keyed by timer name.
- Starting an existing name returns existing metadata (no duplicate `setInterval`).
- Stop/removal is centralized and used from session shutdown and loop stop paths.

## Daily risk cache and usage
- Trade manager keeps `this._dailyRiskEval` cache (`ok`, `reason`, `state`, `updatedAt`, `errorCount`).
- `_safeEvaluateDailyRiskState` updates cache and never throws.
- Entry gate blocks new entries when cache is unavailable (`ok === false`), while existing reconcile/exit loops continue.

## Verify in logs/admin status
- Confirm no `evaluateDailyRiskState is not defined` logs.
- `ticktap` appears once per 10s with stable `ticks10s` and `ticks10sAvg1m`.
- `/admin/status` contains `instanceId`, `pid`, `bootTs`, `timers`, `dailyRiskEval`, and `ws` counters.
- Reconnect logs show stable `subscribedTokenCount` without unbounded growth.
