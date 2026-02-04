const STATUS = {
  ENTRY_PLACED: "ENTRY_PLACED",
  ENTRY_OPEN: "ENTRY_OPEN",
  ENTRY_FILLED: "ENTRY_FILLED",
  LIVE: "LIVE",
  EXITED_TARGET: "EXITED_TARGET",
  EXITED_SL: "EXITED_SL",
  ENTRY_FAILED: "ENTRY_FAILED",
  GUARD_FAILED: "GUARD_FAILED",
  CLOSED: "CLOSED",
};

const ALLOWED_TRANSITIONS = {
  [STATUS.ENTRY_PLACED]: new Set([STATUS.ENTRY_OPEN, STATUS.ENTRY_FILLED, STATUS.ENTRY_FAILED]),
  [STATUS.ENTRY_OPEN]: new Set([STATUS.ENTRY_FILLED, STATUS.ENTRY_FAILED, STATUS.GUARD_FAILED]),
  [STATUS.ENTRY_FILLED]: new Set([STATUS.LIVE, STATUS.EXITED_TARGET, STATUS.EXITED_SL, STATUS.GUARD_FAILED, STATUS.CLOSED]),
  [STATUS.LIVE]: new Set([STATUS.EXITED_TARGET, STATUS.EXITED_SL, STATUS.GUARD_FAILED, STATUS.CLOSED]),
  [STATUS.EXITED_TARGET]: new Set([STATUS.CLOSED]),
  [STATUS.EXITED_SL]: new Set([STATUS.CLOSED]),
  [STATUS.ENTRY_FAILED]: new Set([STATUS.CLOSED]),
  [STATUS.GUARD_FAILED]: new Set([STATUS.CLOSED]),
  [STATUS.CLOSED]: new Set([STATUS.CLOSED]),
};

const TERMINAL = new Set([STATUS.CLOSED, STATUS.EXITED_TARGET, STATUS.EXITED_SL, STATUS.ENTRY_FAILED]);

function normalizeTradeStatus(status) {
  const s = String(status || "").trim().toUpperCase();
  return STATUS[s] || s;
}

function canTransition(fromStatus, toStatus) {
  const from = normalizeTradeStatus(fromStatus);
  const to = normalizeTradeStatus(toStatus);
  if (!from) return { ok: true, reason: "FROM_EMPTY" };
  if (from === to) return { ok: true, reason: "NOOP" };
  if (TERMINAL.has(from) && to !== STATUS.CLOSED) {
    return { ok: false, reason: "FROM_TERMINAL" };
  }
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return { ok: true, reason: "UNKNOWN_FROM" };
  if (allowed.has(to)) return { ok: true, reason: "ALLOWED" };
  return { ok: false, reason: "INVALID_TRANSITION" };
}

module.exports = {
  STATUS,
  normalizeTradeStatus,
  canTransition,
};
