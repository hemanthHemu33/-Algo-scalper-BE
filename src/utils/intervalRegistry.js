const intervals = new Map();

function start(name, fn, ms, opts = {}) {
  const key = String(name || "").trim();
  if (!key) throw new Error("interval name required");
  if (intervals.has(key)) return intervals.get(key);
  const intervalMs = Math.max(1, Number(ms) || 1);
  const meta = {
    name: key,
    ms: intervalMs,
    createdAt: Date.now(),
    lastRunTs: null,
    runCount: 0,
    id: null,
  };
  const wrapped = () => {
    meta.lastRunTs = Date.now();
    meta.runCount += 1;
    return fn();
  };
  const id = setInterval(wrapped, intervalMs);
  if (opts?.unref !== false) id.unref?.();
  meta.id = id;
  intervals.set(key, meta);
  return meta;
}

function stop(name) {
  const key = String(name || "").trim();
  const meta = intervals.get(key);
  if (!meta) return false;
  clearInterval(meta.id);
  intervals.delete(key);
  return true;
}

function stopAll() {
  for (const key of Array.from(intervals.keys())) stop(key);
}

function get(name) {
  const key = String(name || "").trim();
  return intervals.get(key) || null;
}

function snapshot(names = null) {
  const keys = Array.isArray(names) ? names : Array.from(intervals.keys());
  const out = {};
  for (const key of keys) {
    const meta = intervals.get(key);
    if (!meta) continue;
    out[key] = {
      ms: meta.ms,
      createdAt: meta.createdAt,
      lastRunTs: meta.lastRunTs,
      runCount: meta.runCount,
    };
  }
  return out;
}

module.exports = { start, stop, stopAll, get, snapshot };
