const coinService = require('../coins/coinService');

/**
 * Coin movements when an order moves to cancelled with buyer refund.
 * Same rules as PUT /api/orders/:id/status (pending vs active/completed).
 * @param {object} order - row with buyer_id, farmer_id, total_price, preferred_currency, field_name, id
 * @param {string} oldStatus - pending | active | shipped | completed
 * @param {{ pendingRefundReason?: string }} [options]
 */
async function runOrderRefundCoinEffects(order, oldStatus, options = {}) {
    const pendingReason =
        options.pendingRefundReason || `Order Rejected/Cancelled: ${order.field_name}`;

    const coinAmount = await coinService.calculateCoinCost(
        order.total_price,
        order.preferred_currency || 'USD'
    );

    if (oldStatus === 'pending') {
        await coinService.refundCoins(order.buyer_id, coinAmount, {
            reason: pendingReason,
            refType: 'order',
            refId: order.id,
        });
        return { coinAmount, kind: 'pending_refund' };
    }

    if (oldStatus === 'active' || oldStatus === 'shipped' || oldStatus === 'completed') {
        await coinService.deductCoins(order.farmer_id, coinAmount, {
            reason: `Order Cancelled (Reversal): ${order.field_name}`,
            refType: 'order',
            refId: order.id,
        });
        await coinService.refundCoins(order.buyer_id, coinAmount, {
            reason: `Order Cancelled after acceptance: ${order.field_name}`,
            refType: 'order',
            refId: order.id,
        });
        return { coinAmount, kind: 'reversal' };
    }

    const err = new Error(`Cannot refund from order status: ${oldStatus}`);
    err.code = 'INVALID_REFUND_STATUS';
    throw err;
}

module.exports = {
    runOrderRefundCoinEffects,
};
