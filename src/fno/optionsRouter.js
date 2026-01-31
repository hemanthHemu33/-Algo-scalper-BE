const { DateTime } = require("luxon");
const { env } = require("../config");
const { logger } = require("../logger");
const {
  getInstrumentsDump,
  parseCsvList,
  uniq,
} = require("../instruments/instrumentRepo");
const { pickBestExpiryISO } = require("./expiryPolicy");
const {
  getOptionChainSnapshot,
  setLastOptionPick,
} = require("./optionChainCache");

function parseDate(v) {
  if (!v) return null;
  try {
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function todayDate() {
  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  return DateTime.now().setZone(tz).startOf("day").toJSDate();
}

function roundToStep(price, step) {
  const s = Number(step || 1);
  if (!Number.isFinite(s) || s <= 0) return Math.round(price);
  return Math.round(Number(price) / s) * s;
}

function strikeStepFallback(underlying) {
  const u = String(underlying || "").toUpperCase();
  if (u === "NIFTY") return Number(env.OPT_STRIKE_STEP_NIFTY || 50);
  if (u === "BANKNIFTY") return Number(env.OPT_STRIKE_STEP_BANKNIFTY || 100);
  if (u === "SENSEX") return Number(env.OPT_STRIKE_STEP_SENSEX || 100);
  return 50;
}

function getPremiumBandForUnderlying(underlying) {
  const u = String(underlying || "").toUpperCase();
  if (u === "NIFTY") {
    const minPrem = Number(
      env.OPT_MIN_PREMIUM_NIFTY ?? env.OPT_MIN_PREMIUM ?? 80,
    );
    const maxPrem = Number(
      env.OPT_MAX_PREMIUM_NIFTY ?? env.OPT_MAX_PREMIUM ?? 350,
    );
    const enforce = Boolean(env.OPT_PREMIUM_BAND_ENFORCE_NIFTY ?? true);
    return { minPrem, maxPrem, enforce };
  }
  // fallback for other underlyings
  return {
    minPrem: Number(env.OPT_MIN_PREMIUM ?? 20),
    maxPrem: Number(env.OPT_MAX_PREMIUM ?? 600),
    enforce: false,
  };
}

function buildCandidateOffsets(radius) {
  const r = Math.max(0, Number(radius || 2));
  const offsets = [0];
  for (let i = 1; i <= r; i++) offsets.push(i, -i);
  return offsets;
}

function resolveUnderlyingFromUniverse({ universe, token, tradingsymbol }) {
  const uni = universe?.universe;
  if (!uni?.contracts) return null;
  const t = Number(token);
  for (const [u, c] of Object.entries(uni.contracts)) {
    if (Number(c.instrument_token) === t) return u;
    if (
      tradingsymbol &&
      String(c.tradingsymbol).toUpperCase() ===
        String(tradingsymbol).toUpperCase()
    )
      return u;
  }
  return null;
}

function detectStrikeStepFromRows(rows, fallbackStep) {
  // Detect common strike spacing for a specific expiry slice.
  const strikes = Array.from(
    new Set(
      (rows || [])
        .map((r) => Number(r.strike))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ).sort((a, b) => a - b);

  if (strikes.length < 5) return fallbackStep;

  const diffs = [];
  for (let i = 1; i < strikes.length; i++) {
    const d = Math.round((strikes[i] - strikes[i - 1]) * 1000) / 1000;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return fallbackStep;

  // Mode of diffs
  const freq = new Map();
  for (const d of diffs) {
    const k = String(d);
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  let best = null;
  let bestC = -1;
  for (const [k, c] of freq.entries()) {
    if (c > bestC) {
      bestC = c;
      best = Number(k);
    }
  }

  const step = Number(best);
  if (Number.isFinite(step) && step > 0) return step;
  return fallbackStep;
}

function pickNearestExpiryISO(rows) {
  // Returns an ISO yyyy-mm-dd string (nearest non-past expiry).
  const today = todayDate();
  let bestExp = null;
  for (const r of rows || []) {
    const exp = parseDate(r.expiry);
    if (!exp) continue;
    if (exp < today) continue;
    if (!bestExp || exp < bestExp) bestExp = exp;
  }
  return bestExp ? bestExp.toISOString().slice(0, 10) : null;
}

function parseWeights(spec) {
  const s = String(spec || "").trim();
  const out = {
    spread: 1.0,
    dist: 0.2,
    depth: 0.25,
    volume: 0.15,
    oi: 0.1,
  };
  if (!s) return out;
  for (const part of s.split(",")) {
    const [kRaw, vRaw] = part.split(":");
    const k = String(kRaw || "")
      .trim()
      .toLowerCase();
    const v = Number(vRaw);
    if (!k) continue;
    if (Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function scoreCandidate({ bps, distSteps, depthQty, volume, oi, weights }) {
  const w = weights || {};
  const spread = Number.isFinite(bps) ? bps : 1e6;
  const dSteps = Number.isFinite(distSteps) ? distSteps : 999;

  const dep = Math.max(0, Number(depthQty || 0));
  const vol = Math.max(0, Number(volume || 0));
  const openInt = Math.max(0, Number(oi || 0));

  // Lower is better.
  // Penalize spread & distance, reward depth/volume/OI using log for stability.
  const s =
    Number(w.spread ?? 1.0) * spread +
    Number(w.dist ?? 0.2) * dSteps * 10 -
    Number(w.depth ?? 0.25) * Math.log(dep + 1) * 10 -
    Number(w.volume ?? 0.15) * Math.log(vol + 1) * 2 -
    Number(w.oi ?? 0.1) * Math.log(openInt + 1) * 2;

  return s;
}

async function pickOptionContractForSignal({
  kite,
  universe,
  underlyingToken,
  underlyingTradingsymbol,
  side, // BUY/SELL on underlying
  underlyingLtp,
  // Optional dynamic overrides (pacing policy)
  maxSpreadBpsOverride,
  minPremiumOverride,
  maxPremiumOverride,
}) {
  const u = resolveUnderlyingFromUniverse({
    universe,
    token: underlyingToken,
    tradingsymbol: underlyingTradingsymbol,
  });

  const underlying = String(u || "").toUpperCase();
  if (!underlying) {
    throw new Error(
      `[options] cannot resolve underlying for token=${underlyingToken} symbol=${underlyingTradingsymbol}`,
    );
  }

  const dir = String(side || "").toUpperCase();
  const optType = dir === "BUY" ? "CE" : "PE";

  const exchanges = uniq(parseCsvList(env.FNO_EXCHANGES || "NFO,BFO"));

  // Load option rows (CE/PE) for this underlying across allowed exchanges
  const optionRows = [];
  for (const ex of exchanges) {
    const rows = await getInstrumentsDump(kite, ex);
    for (const r of rows || []) {
      const name = String(r.name || "").toUpperCase();
      const it = String(r.instrument_type || "").toUpperCase();
      if (name !== underlying) continue;
      if (it !== optType) continue;
      // Keep exchange explicit (in some dumps it can be blank)
      optionRows.push({ ...r, exchange: r.exchange || ex });
    }
  }

  if (!optionRows.length) {
    throw new Error(`[options] no ${optType} rows found for ${underlying}`);
  }

  // Build expiry set
  const expiries = optionRows
    .map((r) => {
      const exp = parseDate(r.expiry);
      return exp ? exp.toISOString().slice(0, 10) : null;
    })
    .filter(Boolean);

  let expiryISO = pickNearestExpiryISO(optionRows);
  // Apply roll rules (min DTE / avoid expiry-day after cutoff)
  const picked = pickBestExpiryISO({ expiries, env, nowMs: Date.now() });
  if (picked?.expiryISO) expiryISO = picked.expiryISO;

  if (!expiryISO) {
    throw new Error(
      `[options] no valid upcoming expiry found for ${underlying} ${optType}`,
    );
  }

  const slice = optionRows.filter((r) => {
    const exp = parseDate(r.expiry);
    return exp ? exp.toISOString().slice(0, 10) === expiryISO : false;
  });

  const step = detectStrikeStepFromRows(slice, strikeStepFallback(underlying));
  const atm = roundToStep(Number(underlyingLtp), step);

  const offsetSteps = Number(env.OPT_STRIKE_OFFSET_STEPS || 0);
  const desiredStrike = atm + offsetSteps * step;

  const radius = Number(env.OPT_ATM_SCAN_STEPS || 2);
  const offsets = buildCandidateOffsets(radius);

  // For cache + ranking: scan a wider band around desired strike.
  const wide = Math.max(radius, Number(env.OPT_CHAIN_STRIKES_AROUND_ATM || 10));

  // Build candidate strike set
  const strikeSet = new Set();
  for (let i = -wide; i <= wide; i++) {
    strikeSet.add(desiredStrike + i * step);
  }

  const byStrike = new Map();
  for (const r of slice) {
    const k = Number(r.strike);
    if (!Number.isFinite(k)) continue;
    if (strikeSet.has(k)) byStrike.set(k, r);
  }

  // Keep primary strikes (close to desired) first
  const primaryStrikes = offsets
    .map((o) => desiredStrike + o * step)
    .filter((s) => strikeSet.has(s));

  const candidates = [];
  for (const s of primaryStrikes) {
    const row = byStrike.get(s);
    if (row) candidates.push(row);
  }

  // Fill remaining candidates by closeness (avoid huge arrays)
  // Pro scalping: optionally restrict to ATM±scan only (no far strikes)
  if (!env.OPT_STRICT_ATM_ONLY) {
    if (candidates.length < Math.max(6, offsets.length)) {
      const rest = Array.from(byStrike.entries())
        .map(([strike, row]) => ({
          strike,
          row,
          dist: Math.abs(strike - desiredStrike),
        }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, Math.max(20, wide * 2 + 1))
        .map((x) => x.row);

      for (const r of rest) {
        if (
          candidates.find(
            (c) => String(c.tradingsymbol) === String(r.tradingsymbol),
          )
        )
          continue;
        candidates.push(r);
        if (candidates.length >= Math.min(35, Math.max(20, wide * 2 + 1)))
          break;
      }
    }
  }

  if (!candidates.length) {
    throw new Error(
      `[options] no candidates for ${underlying} ${optType} ${expiryISO}`,
    );
  }

  const ttlMs = Number(env.OPT_CHAIN_TTL_MS || 1500);
  const chain = await getOptionChainSnapshot({
    kite,
    underlying,
    optType,
    expiryISO,
    exchanges,
    candidates,
    ttlMs,
  });

  const band = getPremiumBandForUnderlying(underlying);
  const minPrem = Number(
    Number.isFinite(Number(minPremiumOverride))
      ? minPremiumOverride
      : band.minPrem,
  );
  const maxPrem = Number(
    Number.isFinite(Number(maxPremiumOverride))
      ? maxPremiumOverride
      : band.maxPrem,
  );
  const enforcePremBand = Boolean(band.enforce);
  const maxBps = Number(
    Number.isFinite(Number(maxSpreadBpsOverride))
      ? maxSpreadBpsOverride
      : env.OPT_MAX_SPREAD_BPS || 35,
  );
  const minDepth = Number(env.OPT_MIN_DEPTH_QTY || 0);

  const weights = parseWeights(env.OPT_PICK_SCORE_WEIGHTS);

  // Optional debug payload (kept OFF by default)
  // Helps you see why a specific option was picked (top N candidates).
  // Set OPT_PICK_DEBUG_TOP_N=5 (max 10) to include a small top-candidates list in the pick metadata.
  const debugTopN = Math.max(
    0,
    Math.min(Number(env.OPT_PICK_DEBUG_TOP_N || 0), 10),
  );

  const scored = (chain?.snapshot?.rows || [])
    .map((r) => {
      const ltp = Number(r.ltp);
      const bps = Number(r.spread_bps);
      const premOk = Number.isFinite(ltp)
        ? ltp >= minPrem && ltp <= maxPrem
        : true;
      const spreadOk = Number.isFinite(bps) ? bps <= maxBps : true;
      const depthOk =
        Number(minDepth) > 0
          ? Number(r.depth_qty_top || 0) >= Number(minDepth)
          : true;

      const dist = Math.abs(Number(r.strike) - desiredStrike);
      const distSteps = step > 0 ? dist / step : dist;

      const score = scoreCandidate({
        bps,
        distSteps,
        depthQty: r.depth_qty_top,
        volume: r.volume,
        oi: r.oi,
        weights,
      });

      return {
        row: r,
        ok: premOk && spreadOk && depthOk,
        premOk,
        spreadOk,
        depthOk,
        dist,
        distSteps,
        score,
      };
    })
    .sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (a.score !== b.score) return a.score - b.score;
      return a.dist - b.dist;
    });

  const requireOk = !!env.OPT_PICK_REQUIRE_OK;

  // Eligible candidates:
  // - premium band enforced for NIFTY when enabled
  // - and (pro) require ok => spreadOk & depthOk & premOk
  const eligible = scored.filter((x) => {
    if (enforcePremBand && !x.premOk) return false;
    if (requireOk && !x.ok) return false;
    return true;
  });

  if (eligible.length === 0) {
    const why = requireOk
      ? "no OK candidate (spread/depth/premium gates)"
      : "no candidate in premium band";
    throw new Error(
      `[options] ${why} for ${underlying} ${optType} (minPrem=${minPrem}, maxPrem=${maxPrem}, maxBps=${maxBps}, minDepth=${minDepth})`,
    );
  }

  const best = eligible[0];

  const topCandidates =
    debugTopN > 0
      ? eligible.slice(0, debugTopN).map((x) => ({
          tradingsymbol: x.row.tradingsymbol,
          strike: Number(x.row.strike),
          ltp: Number(x.row.ltp),
          spread_bps: Number(x.row.spread_bps),
          depth_qty_top: Number(x.row.depth_qty_top || 0),
          volume: Number(x.row.volume || 0),
          oi: Number(x.row.oi || 0),
          distSteps: Number(x.distSteps),
          score: Number(x.score),
          ok: !!x.ok,
          premOk: !!x.premOk,
          spreadOk: !!x.spreadOk,
          depthOk: !!x.depthOk,
        }))
      : undefined;

  const selection = {
    underlying,
    optType,
    expiry: expiryISO,
    atmStrike: atm,
    desiredStrike,
    strikeStep: step,
    premiumBand: {
      minPrem,
      maxPrem,
      enforced: enforcePremBand,
    },
    instrument_token: Number(best.row.instrument_token),
    exchange: best.row.exchange,
    tradingsymbol: best.row.tradingsymbol,
    segment: best.row.segment,
    lot_size: Number(best.row.lot_size || 1),
    tick_size: Number(best.row.tick_size || 0.05),
    strike: Number(best.row.strike),
    pickedAt: new Date().toISOString(),
    meta: {
      policy: picked?.policy || null,
      minPrem,
      maxPrem,
      maxBps,
      minDepth,
      weights,
      fromCache: !!chain?.fromCache,
      chainCount: Number(chain?.snapshot?.count || 0),
      topCandidates,
    },
  };

  // Log selection (helps debugging)
  logger.info(
    {
      underlying,
      optType,
      expiry: expiryISO,
      atm,
      desiredStrike,
      step,
      selected: {
        tradingsymbol: best.row.tradingsymbol,
        strike: best.row.strike,
        exchange: best.row.exchange,
        token: best.row.instrument_token,
        ltp: best.row.ltp,
        bps: best.row.spread_bps,
        depth: best.row.depth_qty_top,
        score: best.score,
        ok: best.ok,
      },
    },
    "[options] selected contract (liquidity-rank)",
  );

  setLastOptionPick(underlying, selection);

  return selection;
}

module.exports = {
  pickOptionContractForSignal,
};
