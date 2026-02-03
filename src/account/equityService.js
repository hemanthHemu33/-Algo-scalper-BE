const { getAvailableEquityMargin } = require("../trading/marginSizer");
const { logger } = require("../logger");

function pickNumber(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseMargins(margins) {
  const eq =
    margins?.equity || margins?.data?.equity || margins?.equity_margins || {};
  const available = eq?.available || margins?.available || {};
  const utilized = eq?.utilized || margins?.utilized || {};

  return {
    equity: pickNumber(eq?.net, eq?.net_balance, margins?.net),
    cash: pickNumber(
      available?.cash,
      available?.live_balance,
      available?.opening_balance,
      available?.adhoc_margin,
    ),
    available: pickNumber(getAvailableEquityMargin(margins)),
    utilized: pickNumber(utilized?.debits, utilized?.span, utilized?.exposure),
    raw: margins || null,
  };
}

class EquityService {
  constructor({ ringSize = 500 } = {}) {
    this.ringSize = ringSize;
    this.curve = [];
  }

  _pushPoint(point) {
    this.curve.push(point);
    if (this.curve.length > this.ringSize) {
      this.curve.splice(0, this.curve.length - this.ringSize);
    }
  }

  async snapshot({ kite }) {
    let margins = null;
    let positions = null;
    try {
      margins = kite ? await kite.getMargins() : null;
    } catch (e) {
      logger.warn({ e: e?.message || String(e) }, "[equity] getMargins failed");
    }

    try {
      positions = kite ? await kite.getPositions() : null;
    } catch (e) {
      logger.warn({ e: e?.message || String(e) }, "[equity] getPositions failed");
    }

    const net = positions?.net || positions?.day || [];
    const realized = net.reduce((acc, p) => {
      const v = Number(p?.realised ?? p?.realized ?? 0);
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0);
    const unrealized = net.reduce((acc, p) => {
      const v = Number(p?.unrealised ?? p?.unrealized ?? 0);
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0);

    const marginMeta = parseMargins(margins);
    const point = {
      ts: Date.now(),
      equity: marginMeta.equity,
      cash: marginMeta.cash,
      available: marginMeta.available,
      utilized: marginMeta.utilized,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
      totalPnl: realized + unrealized,
    };

    this._pushPoint(point);

    return {
      snapshot: point,
      curve: this.curve.slice(-this.ringSize),
      margins: marginMeta,
    };
  }
}

const equityService = new EquityService();

module.exports = { EquityService, equityService };
