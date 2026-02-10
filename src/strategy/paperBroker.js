class PaperBroker {
  constructor({ slippageBps = 5, partialFillPct = 0.6 } = {}) {
    this.orders = new Map();
    this.positions = new Map();
    this.slippageBps = Number(slippageBps);
    this.partialFillPct = Number(partialFillPct);
  }

  placeOrder(order) {
    const id = `PB-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.orders.set(id, { ...order, order_id: id, status: "OPEN", filled_quantity: 0 });
    return { order_id: id };
  }

  onTick({ tradingsymbol, price }) {
    for (const [id, o] of this.orders.entries()) {
      if (o.tradingsymbol !== tradingsymbol || o.status !== "OPEN") continue;
      const qty = Number(o.quantity || 0);
      if (qty <= 0) continue;
      const fillQty = Math.max(1, Math.floor(qty * this.partialFillPct));
      const bps = this.slippageBps / 10000;
      const fillPx =
        String(o.transaction_type || "BUY").toUpperCase() === "BUY"
          ? Number(price) * (1 + bps)
          : Number(price) * (1 - bps);
      o.filled_quantity = Math.min(qty, Number(o.filled_quantity || 0) + fillQty);
      o.average_price = fillPx;
      o.status = o.filled_quantity >= qty ? "COMPLETE" : "PARTIAL";
      this.orders.set(id, o);
    }
  }

  getOrders() {
    return Array.from(this.orders.values());
  }
}

module.exports = { PaperBroker };
