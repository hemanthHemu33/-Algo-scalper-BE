const { getActiveTrades } = require("./tradeStore");

function positionSide(qty) {
  if (qty > 0) return "LONG";
  if (qty < 0) return "SHORT";
  return "FLAT";
}

async function buildPositionsSnapshot({ kite }) {
  let positions = null;
  try {
    positions = kite ? await kite.getPositions() : null;
  } catch {
    positions = null;
  }

  const net = Array.isArray(positions?.net || positions?.day)
    ? positions?.net || positions?.day
    : [];

  const activeTrades = await getActiveTrades().catch(() => []);
  const tradeByToken = new Map(
    activeTrades.map((t) => [Number(t?.instrument_token), t]),
  );

  const rows = net.map((p) => {
    const qty = Number(p?.quantity ?? p?.net_quantity ?? 0);
    const avgPrice = Number(
      p?.average_price ?? p?.buy_price ?? p?.sell_price ?? 0,
    );
    const lastPrice = Number(p?.last_price ?? p?.ltp ?? 0);
    const realized = Number(p?.realised ?? p?.realized ?? 0);
    const unrealized = Number(p?.unrealised ?? p?.unrealized ?? 0);
    const pnl = Number(p?.pnl ?? realized + unrealized);

    const exposure =
      Number.isFinite(lastPrice) && lastPrice !== 0
        ? Math.abs(qty * lastPrice)
        : Number.isFinite(avgPrice)
          ? Math.abs(qty * avgPrice)
          : null;

    const trade = tradeByToken.get(Number(p?.instrument_token));
    let riskInr = null;
    if (trade?.riskInr) {
      riskInr = Number(trade.riskInr) || null;
    } else if (trade?.stopLoss && Number.isFinite(avgPrice) && qty !== 0) {
      const stop = Number(trade.stopLoss);
      riskInr = Number.isFinite(stop)
        ? Math.abs((avgPrice - stop) * qty)
        : null;
    }

    return {
      instrument_token: Number(p?.instrument_token) || null,
      tradingsymbol: p?.tradingsymbol || p?.symbol || null,
      exchange: p?.exchange || null,
      product: p?.product || null,
      qty,
      side: positionSide(qty),
      avgPrice: Number.isFinite(avgPrice) ? avgPrice : null,
      lastPrice: Number.isFinite(lastPrice) ? lastPrice : null,
      pnl: Number.isFinite(pnl) ? pnl : null,
      realizedPnl: Number.isFinite(realized) ? realized : null,
      unrealizedPnl: Number.isFinite(unrealized) ? unrealized : null,
      exposureInr: exposure,
      riskInr,
      tradeId: trade?.tradeId || null,
      strategyId: trade?.strategyId || null,
    };
  });

  return rows;
}

module.exports = { buildPositionsSnapshot };
