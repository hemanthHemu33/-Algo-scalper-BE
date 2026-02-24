# RUNBOOK — Idle Mode Lifecycle

## Enable
Set:
- `ENGINE_LIFECYCLE_ENABLED=true`
- `MARKET_TZ=Asia/Kolkata`
- optional schedule envs (`ENGINE_WARMUP_HHMM`, `ENGINE_LIVE_HHMM`, `ENGINE_CLOSE_HHMM`)

## Expected lifecycle
- `IDLE`: ticker/pipeline stopped, no heavy loops.
- `WARMUP`: session starts, trading disabled.
- `LIVE`: trading enabled.
- `COOLDOWN`: trading disabled, waits flat, then stops session and returns to `IDLE`.

## Telegram lifecycle events
Uses existing alert stack. Events emitted:
- `WARMUP_START`, `LIVE_START`, `CLOSE_START`, `IDLE_ENTER`
- `FORCE_FLATTEN_START`, `FORCE_FLATTEN_RESULT`
- `TOKEN_MISSING`, `TOKEN_RESTORED`

Deduplication: same event is suppressed for 10 minutes.

## Token missing operations
1. Check `/admin/status`:
   - `tokenPresent=false`
   - `needsKiteLogin=true`
   - `kiteLoginUrl` set (if `KITE_API_KEY` configured)
2. Regenerate Kite access token and store in tokens collection.
3. Watch logs for `TOKEN_RESTORED` then `WARMUP_START`/`LIVE_START` as per schedule.

## Cooldown policy
- `ENGINE_REQUIRE_FLAT_BEFORE_IDLE=true` keeps session alive until positions are flat.
- `ENGINE_FORCE_FLATTEN_AT_CLOSE=true` attempts flatten via trader force-flat helper.
- `ENGINE_COOLDOWN_POLL_SEC` controls close-time flat-check poll cadence.

## Simulation / dry-run time override
For local testing only:
- `ENGINE_TEST_NOW_ISO=2026-01-15T09:14:00+05:30`
This overrides lifecycle clock used for transition decisions.
