const { getOrderLogs } = require("./tradeStore");

function normalizeOrder(order) {
  if (!order) return null;
  return {
    order_id: String(order.order_id || order.orderId || ""),
    status: order.status || null,
    status_message: order.status_message || order.status_message_raw || null,
    tradingsymbol: order.tradingsymbol || null,
    exchange: order.exchange || null,
    product: order.product || null,
    variety: order.variety || null,
    order_type: order.order_type || order.orderType || null,
    transaction_type: order.transaction_type || order.transactionType || null,
    qty: Number(order.quantity ?? order.qty ?? 0) || 0,
    filled_qty: Number(order.filled_quantity ?? order.filledQty ?? 0) || 0,
    pending_qty: Number(order.pending_quantity ?? order.pendingQty ?? 0) || 0,
    price: Number(order.price ?? 0) || null,
    average_price: Number(order.average_price ?? 0) || null,
    exchange_timestamp: order.exchange_timestamp || null,
    order_timestamp: order.order_timestamp || order.orderTimestamp || null,
  };
}

async function fetchOrders({ kite }) {
  if (!kite) return [];
  const orders = await kite.getOrders();
  return Array.isArray(orders) ? orders : [];
}

async function getOrdersSnapshot({ kite }) {
  const orders = await fetchOrders({ kite });
  return orders.map(normalizeOrder).filter(Boolean);
}

async function getOrderHistory({ kite, orderId }) {
  if (!kite || !orderId) return [];
  const rows = await kite.getOrderHistory(orderId);
  return Array.isArray(rows) ? rows.map(normalizeOrder).filter(Boolean) : [];
}

async function getOrderLogsSnapshot({ orderId, tradeId, limit }) {
  const logs = await getOrderLogs({ order_id: orderId, tradeId, limit });
  return logs.map((l) => ({
    id: l._id,
    order_id: l.order_id,
    tradeId: l.tradeId || null,
    status: l.status || null,
    payload: l.payload || null,
    createdAt: l.createdAt || null,
  }));
}

module.exports = {
  getOrdersSnapshot,
  getOrderHistory,
  getOrderLogsSnapshot,
};
