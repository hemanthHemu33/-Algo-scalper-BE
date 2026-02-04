// quoteStability.js
// Entry-time stability gate for top-of-book (spread + depth) to reduce spoof/pull-liquidity risk.

const { env } = require("../config");
const { logger } = require("../logger");
const { getQuoteGuarded } = require("./quoteGuard");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeUpper(s) {
  return String(s || "").toUpperCase();
}

function calcSpreadBps(bid, ask) {
  const b = Number(bid);
  const a = Number(ask);
  if (!(b > 0) || !(a > 0)) return null;
  const mid = (b + a) / 2;
  if (!(mid > 0)) return null;
  return ((a - b) / mid) * 10000;
}

function extractTop(q) {
  const bid = Number(q?.depth?.buy?.[0]?.price);
  const ask = Number(q?.depth?.sell?.[0]?.price);
  const bidQty = Number(q?.depth?.buy?.[0]?.quantity);
  const askQty = Number(q?.depth?.sell?.[0]?.quantity);
  const ltp = Number(q?.last_price);

  return {
    bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null,
    bidQty: Number.isFinite(bidQty) ? bidQty : null,
    askQty: Number.isFinite(askQty) ? askQty : null,
    ltp: Number.isFinite(ltp) ? ltp : null,
  };
}

/**
 * Stability criteria:
 * - spreadBps must be <= maxSpreadBps for ALL snapshots
 * - spread jitter (max-min) must be <= maxSpreadJitterBps
 * - top qty on the execution side must be >= minTopQty for ALL snapshots
 * - top qty drop (first -> min across snapshots) must be <= maxTopQtyDropPct
 */
async function checkTopOfBookStability({
  kite,
  instrument,
  side,
  // Optional overrides
  maxSpreadBps,
  snapshots,
  windowMs,
  maxSpreadJitterBps,
  minTopQty,
  maxTopQtyDropPct,
  purpose,
}) {
  const ex = instrument?.exchange || env.DEFAULT_EXCHANGE || "NSE";
  const sym = instrument?.tradingsymbol;
  const key = `${safeUpper(ex)}:${safeUpper(sym)}`;

  const n = Math.max(2, Number(snapshots || env.ENTRY_QUOTE_STABILITY_SNAPSHOTS || 3));
  const totalWindow = Math.max(0, Number(windowMs || env.ENTRY_QUOTE_STABILITY_WINDOW_MS || 1500));
  const stepMs = n > 1 ? Math.floor(totalWindow / (n - 1)) : 0;

  const maxBps = Number.isFinite(Number(maxSpreadBps))
    ? Number(maxSpreadBps)
    : Number(env.MAX_SPREAD_BPS || 15);

  const jitterBps = Number.isFinite(Number(maxSpreadJitterBps))
    ? Number(maxSpreadJitterBps)
    : Number(env.ENTRY_QUOTE_STABILITY_MAX_SPREAD_JITTER_BPS || 4);

  const minQty = Number.isFinite(Number(minTopQty)) ? Number(minTopQty) : 0;

  const maxDropPct = Number.isFinite(Number(maxTopQtyDropPct))
    ? Number(maxTopQtyDropPct)
    : Number(env.ENTRY_QUOTE_STABILITY_MAX_TOP_QTY_DROP_PCT || 40);

  const s = safeUpper(side || "BUY");
  const qtyField = s === "SELL" ? "bidQty" : "askQty";

  const samples = [];

  for (let i = 0; i < n; i++) {
    const startedAt = Date.now();

    const resp = await getQuoteGuarded(kite, [key], {
      purpose: String(purpose || "ENTRY_STABILITY").toUpperCase(),
    });

    if (!resp || typeof resp !== "object") {
      return {
        ok: false,
        reason: "QUOTE_FETCH_FAILED (no_response)",
        meta: { key, i, error: "no_response" },
      };
    }

    const q = resp?.[key];
    if (!q) {
      return {
        ok: false,
        reason: "QUOTE_FETCH_FAILED (missing_quote)",
        meta: { key, i, error: "missing_quote" },
      };
    }
    const t = extractTop(q);

    if (!(t.bid > 0) || !(t.ask > 0)) {
      return {
        ok: false,
        reason: "NO_TOP_OF_BOOK",
        meta: { key, i, note: "missing bid/ask", raw: null },
      };
    }

    const bps = calcSpreadBps(t.bid, t.ask);

    const sideQty = Number(t[qtyField] || 0);
    const depthQtyTop = Number(t.bidQty || 0) + Number(t.askQty || 0);


    samples.push({
      ts: startedAt,
      bid: t.bid,
      ask: t.ask,
      ltp: t.ltp,
      bidQty: t.bidQty,
      askQty: t.askQty,
      depthQtyTop,
      bps: Number.isFinite(bps) ? bps : null,
      sideQty,
    });

    if (i < n - 1 && stepMs > 0) {
      const elapsed = Date.now() - startedAt;
      const wait = Math.max(0, stepMs - elapsed);
      if (wait > 0) await sleep(wait);
    }
  }

  const bpsList = samples
    .map((x) => Number(x.bps))
    .filter((x) => Number.isFinite(x));
  const minBps = bpsList.length ? Math.min(...bpsList) : null;
  const maxBpsSeen = bpsList.length ? Math.max(...bpsList) : null;
  const jitter =
    minBps != null && maxBpsSeen != null ? maxBpsSeen - minBps : null;

  // Per-sample constraints
  for (const smp of samples) {
    if (!(Number(smp.bps) >= 0)) {
      return {
        ok: false,
        reason: "BAD_SPREAD_SAMPLE",
        meta: { key, sample: smp },
      };
    }
    if (Number(smp.bps) > maxBps) {
      return {
        ok: false,
        reason: `SPREAD_UNSTABLE (${Number(smp.bps).toFixed(1)} bps > ${maxBps})`,
        meta: {
          key,
          maxBps,
          sample: { bid: smp.bid, ask: smp.ask, bps: smp.bps, sideQty: smp.sideQty },
        },
      };
    }
    if (minQty > 0 && Number(smp.sideQty) < minQty) {
      return {
        ok: false,
        reason: `TOP_QTY_TOO_LOW (${Number(smp.sideQty)} < ${minQty})`,
        meta: {
          key,
          minQty,
          sample: { bid: smp.bid, ask: smp.ask, sideQty: smp.sideQty, bps: smp.bps },
        },
      };
    }
  }

  if (jitter != null && jitterBps > 0 && jitter > jitterBps) {
    return {
      ok: false,
      reason: `SPREAD_JITTER (${jitter.toFixed(1)} bps > ${jitterBps})`,
      meta: { key, jitter, jitterBps, minBps, maxBpsSeen },
    };
  }

  // Liquidity pull check: compare first sideQty to min sideQty across snapshots
  const firstQty = Number(samples?.[0]?.sideQty || 0);
  const minQtySeen = Math.min(...samples.map((x) => Number(x.sideQty || 0)));

  if (!(firstQty > 0)) {
    return {
      ok: false,
      reason: "TOP_QTY_ZERO",
      meta: { key, firstQty, minQtySeen },
    };
  }

  const dropPct = ((firstQty - minQtySeen) / firstQty) * 100;
  if (Number.isFinite(dropPct) && dropPct > maxDropPct) {
    return {
      ok: false,
      reason: `TOP_QTY_DROPPED (${dropPct.toFixed(1)}% > ${maxDropPct}%)`,
      meta: { key, firstQty, minQtySeen, dropPct, maxDropPct },
    };
  }

  const last = samples[samples.length - 1];
  const sidePrice = s === "SELL" ? last?.bid : last?.ask;

  return {
    ok: true,
    meta: {
      key,
      side: s,
      snapshots: n,
      windowMs: totalWindow,
      maxSpreadBps: maxBps,
      maxSpreadJitterBps: jitterBps,
      minTopQty: minQty,
      maxTopQtyDropPct: maxDropPct,
      summary: {
        minBps,
        maxBpsSeen,
        jitter,
        firstQty,
        minQtySeen,
        dropPct,
        lastSidePrice: sidePrice,
      },
      last: {
        bid: last?.bid,
        ask: last?.ask,
        ltp: last?.ltp,
        bps: last?.bps,
        bidQty: last?.bidQty,
        askQty: last?.askQty,
        depthQtyTop: last?.depthQtyTop,
        sideQty: last?.sideQty,
        sidePrice,
      },
      // Do NOT return full samples by default (keeps trade documents small)
    },
  };
}

module.exports = {
  checkTopOfBookStability,
};
