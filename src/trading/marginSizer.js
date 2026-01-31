const { env } = require("../config");
const { logger } = require("../logger");

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function pickNum(...vals) {
  for (const v of vals) {
    const n = num(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function getAvailableEquityMargin(margins) {
  // Kite margins response shapes vary slightly across clients/versions.
  const eq =
    margins?.equity || margins?.data?.equity || margins?.equity_margins;
  const available = eq?.available || margins?.available || {};

  // Prefer 'available.live_balance' (current available funds).
  // Fallback to net-like fields when the exact shape differs.
  return pickNum(
    available.live_balance,
    available.cash,
    available.opening_balance,
    available.adhoc_margin,
    eq?.net,
    eq?.net_balance,
    eq?.net_cash,
    eq?.net_available,
    margins?.net
  );
}

function capQtyByConfig({ qty, entryPriceGuess }) {
  let out = Math.max(0, Math.floor(qty || 0));

  // Hard cap: MAX_QTY
  const maxQty = num(env.MAX_QTY);
  if (Number.isFinite(maxQty) && maxQty > 0) {
    out = Math.min(out, Math.floor(maxQty));
  }

  // Exposure cap: MAX_POSITION_VALUE_INR (uses price guess, not leveraged margin).
  const maxPosVal = num(env.MAX_POSITION_VALUE_INR);
  const px = num(entryPriceGuess);
  if (
    Number.isFinite(maxPosVal) &&
    maxPosVal > 0 &&
    Number.isFinite(px) &&
    px > 0
  ) {
    out = Math.min(out, Math.floor(maxPosVal / px));
  }

  // Absolute hardcap: MAX_QTY_HARDCAP (always enforced)
  const hardCap = num(env.MAX_QTY_HARDCAP);
  if (Number.isFinite(hardCap) && hardCap > 0) {
    out = Math.min(out, Math.floor(hardCap));
  }

  return Math.max(0, out);
}

async function calcMarginsForOrder({ kite, params, qty, entryPriceGuess }) {
  const q = Math.max(0, Math.floor(qty || 0));
  if (!q) return { required: 0, total: 0, chargesTotal: 0, raw: null };

  // If the client supports the order margins endpoint, use it.
  if (kite && typeof kite.orderMargins === "function") {
    try {
      const order_type = params.order_type || params.orderType || "MARKET";

      // Zerodha expects 0 for unused price/trigger_price on MARKET orders,
      // but supplying a reasonable price helps make the calculation realistic.
      const pxGuess = num(entryPriceGuess);
      const price =
        order_type === "MARKET"
          ? Number.isFinite(pxGuess) && pxGuess > 0
            ? pxGuess
            : 0
          : pickNum(params.price, params.price !== 0 ? params.price : 0, 0);

      const trigger_price = pickNum(
        params.trigger_price,
        params.triggerPrice,
        params.trigger,
        0
      );

      const req = {
        exchange: params.exchange,
        tradingsymbol: params.tradingsymbol,
        transaction_type: params.transaction_type,
        quantity: q,
        product: params.product || env.DEFAULT_PRODUCT || "MIS",
        order_type,
        price,
        trigger_price,
        variety: params.variety || env.DEFAULT_ORDER_VARIETY || "regular",
      };

      const resp = await kite.orderMargins([req]);
      const row = Array.isArray(resp)
        ? resp[0]
        : Array.isArray(resp?.data)
        ? resp.data[0]
        : resp?.data || resp;

      if (!row)
        return { required: NaN, total: NaN, chargesTotal: NaN, raw: resp };

      // Standard fields are `total` and `charges.total`, but keep fallbacks.
      const total = pickNum(
        row.total,
        row.total_margin,
        row.totalMargin,
        row.total_required,
        row.totalRequired,
        row.margin?.total,
        row.margin?.total_margin
      );

      const chargesTotal = pickNum(
        row.charges?.total,
        row.charges_total,
        row.total_charges,
        row.charges?.total_charges
      );

      const required =
        total + (Number.isFinite(chargesTotal) ? chargesTotal : 0);

      return { required, total, chargesTotal, raw: row };
    } catch (e) {
      logger.warn(
        { e: e?.message || e },
        "[margin] orderMargins failed; falling back to estimate"
      );
      // fallthrough to estimate
    }
  }

  // Fallback estimate (rough): use product-based leverage assumptions.
  // MIS equity is typically leveraged; CNC requires full value.
  const px = num(entryPriceGuess);
  const product = String(
    params.product || env.DEFAULT_PRODUCT || "MIS"
  ).toUpperCase();
  const value = Number.isFinite(px) && px > 0 ? px * q : NaN;
  if (!Number.isFinite(value))
    return { required: NaN, total: NaN, chargesTotal: 0, raw: null };

  // Conservative estimate when we can't call the broker margin calculator.
  // For MIS equity intraday, assume higher margin for SELL to avoid "Insufficient funds" rejects.
  // CNC typically requires full value.
  const side = String(params.transaction_type || "BUY").toUpperCase();
  let mult = 1.0;
  if (product === "MIS") {
    mult = side === "SELL" ? 0.35 : 0.25;
  }
  const total = value * mult;
  return { required: total, total, chargesTotal: 0, raw: null };
}

async function findMaxQtyUnderMargin({
  kite,
  entryParams,
  entryPriceGuess,
  maxQty,
  effAvailable,
}) {
  let lo = 1;
  let hi = Math.max(1, Math.floor(maxQty));
  let best = 0;

  // Limit API calls. Iterations scale with the search range.
  const range = Math.max(1, hi - lo + 1);
  const iters = Math.min(20, Math.ceil(Math.log2(range)) + 2);

  for (let i = 0; i < iters && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const m = await calcMarginsForOrder({
      kite,
      params: entryParams,
      qty: mid,
      entryPriceGuess,
    });

    if (!Number.isFinite(m.required) || m.required <= 0) {
      // If we can't compute reliably, be conservative and shrink.
      hi = mid - 1;
      continue;
    }

    if (m.required <= effAvailable) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best;
}

async function marginAwareQty({
  kite,
  entryParams,
  entryPriceGuess,
  qtyByRisk,
}) {
  // Quantity derived from risk sizing (ATR/SL distance etc.)
  const wanted = Math.max(0, Math.floor(qtyByRisk || 0));
  if (wanted < 1) return 0;

  // Apply static caps first.
  let qtyCap = capQtyByConfig({ qty: wanted, entryPriceGuess });
  if (qtyCap < 1) return 0;

  // Allow disabling margin sizing (use only risk sizing/caps).
  if (String(env.USE_MARGIN_SIZING) !== "true") return qtyCap;

  // Get currently available funds.
  let margins;
  try {
    margins = await kite.getMargins();
  } catch (e) {
    logger.warn(
      { e: e?.message || e },
      "[margin] getMargins failed; using qtyCap"
    );
    return qtyCap;
  }

  const available = getAvailableEquityMargin(margins);
  if (!Number.isFinite(available) || available <= 0) {
    logger.warn(
      { available },
      "[margin] could not parse available equity margin; using qtyCap"
    );
    return qtyCap;
  }

  const bufferPct = clampInt(env.MARGIN_BUFFER_PCT ?? 5, 0, 50);
  const usePct = clampInt(env.MARGIN_USE_PCT ?? 100, 0, 100);
  const effAvailable = available * (1 - bufferPct / 100) * (usePct / 100);

  if (!Number.isFinite(effAvailable) || effAvailable <= 0) return 0;

  // First try with qtyCap.
  const mCap = await calcMarginsForOrder({
    kite,
    params: entryParams,
    qty: qtyCap,
    entryPriceGuess,
  });

  if (!Number.isFinite(mCap.required) || mCap.required <= 0) {
    // If margin calc fails, keep qtyCap.
    return qtyCap;
  }

  if (mCap.required <= effAvailable) {
    return qtyCap;
  }

  // Quick proportional downscale to reduce API calls.
  // Scale down to about 95% of the theoretically max qty.
  let scaled = Math.floor((qtyCap * effAvailable) / mCap.required);
  scaled = Math.floor(scaled * 0.95);
  scaled = Math.max(0, Math.min(qtyCap - 1, scaled));

  if (scaled < 1) {
    logger.info(
      { qtyCap, required: mCap.required, effAvailable },
      "[margin] insufficient funds even for 1 qty"
    );
    return 0;
  }

  // Verify scaled is actually within limits; if yes, try to grow with binary search.
  const mScaled = await calcMarginsForOrder({
    kite,
    params: entryParams,
    qty: scaled,
    entryPriceGuess,
  });

  if (Number.isFinite(mScaled.required) && mScaled.required <= effAvailable) {
    const best = await findMaxQtyUnderMargin({
      kite,
      entryParams,
      entryPriceGuess,
      maxQty: qtyCap,
      effAvailable,
    });

    logger.info(
      {
        qtyByRisk: wanted,
        qtyCap,
        finalQty: best,
        available,
        effAvailable,
        requiredCap: mCap.required,
      },
      "[margin] resized qty based on available funds"
    );

    return best;
  }

  // If scaled still not enough, binary search below it.
  const best = await findMaxQtyUnderMargin({
    kite,
    entryParams,
    entryPriceGuess,
    maxQty: scaled,
    effAvailable,
  });

  logger.info(
    {
      qtyByRisk: wanted,
      qtyCap,
      scaled,
      finalQty: best,
      available,
      effAvailable,
      requiredCap: mCap.required,
    },
    "[margin] resized qty based on available funds"
  );

  return best;
}

module.exports = {
  marginAwareQty,
  getAvailableEquityMargin,
  calcMarginsForOrder,
};
