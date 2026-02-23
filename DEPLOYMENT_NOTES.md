# Deployment Notes (Health Checks)

## Render / Hosting health-check guidance

Use **`/health`** as liveness and **`/ready`** as readiness:

- `/health` returns process-level health (`200` when API process is up).
- `/ready` returns `200` only when pipeline is initialized, ticker is connected, and trading is not halted.

### Recommended Render setup

- `healthCheckPath: /ready` (already set in `render.yaml`).
- Keep external uptime monitors on `/health` so temporary Kite/login issues don't trigger unnecessary restarts.

### Optional deep checks

- `/admin/health/critical` gives detailed trade-safety checks (halt/kill-switch/quote-breaker/ticker).
- If `ADMIN_API_KEY` is enabled, your monitor must send auth headers.
  Most hosting built-in health checks cannot send custom headers, so do **not** use this endpoint as Render's native health path.
