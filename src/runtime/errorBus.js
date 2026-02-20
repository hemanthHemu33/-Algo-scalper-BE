const { logger } = require("../logger");

const _faults = new Map();
const _onceWindows = new Map();

function _now() {
  return Date.now();
}

function incrementFault(code, meta = {}) {
  const key = String(code || "UNKNOWN_FAULT");
  const prev = _faults.get(key) || { count: 0, lastAt: null, lastMeta: null };
  const next = {
    count: Number(prev.count || 0) + 1,
    lastAt: new Date().toISOString(),
    lastMeta: meta || null,
  };
  _faults.set(key, next);
  return { code: key, ...next };
}

function reportFault({ code, err, message, meta } = {}) {
  const payload = incrementFault(code, {
    ...(meta || {}),
    err: err?.message || (typeof err === "string" ? err : null),
  });
  logger.warn(
    {
      code: payload.code,
      count: payload.count,
      err: err?.message || String(err || ""),
      meta: meta || null,
    },
    message || "[fault] captured",
  );
  return payload;
}

function reportWindowedFault({
  windowKey,
  windowMs = 60_000,
  code,
  err,
  message,
  meta,
} = {}) {
  const key = String(windowKey || code || "windowed_fault");
  const now = _now();
  const until = Number(_onceWindows.get(key) || 0);
  if (now < until) {
    incrementFault(code || key, meta);
    return { logged: false };
  }
  _onceWindows.set(key, now + Math.max(1000, Number(windowMs || 0)));
  reportFault({ code: code || key, err, message, meta });
  return { logged: true };
}

function snapshotFaults() {
  const byCode = {};
  let total = 0;
  for (const [code, v] of _faults.entries()) {
    byCode[code] = { ...v };
    total += Number(v?.count || 0);
  }
  return { total, byCode };
}

module.exports = {
  incrementFault,
  reportFault,
  reportWindowedFault,
  snapshotFaults,
};
