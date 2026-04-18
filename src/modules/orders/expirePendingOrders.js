const pool = require('../../../db');
const { runOrderRefundCoinEffects } = require('./orderRefundEffects');

const DEFAULT_EXPIRY_DAYS = 7;

function getExpiryDays() {
    const n = parseInt(process.env.PENDING_ORDER_EXPIRY_DAYS, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_EXPIRY_DAYS;
}

/**
 * Cancel pending orders whose farmer never accepted within PENDING_ORDER_EXPIRY_DAYS (default 7).
 * Refunds buyer coins (same as manual pending → cancelled). Notifies buyer and farmer.
 * Closes any pending buyer refund requests on those orders (table may not exist on old DBs).
 */
async function runPendingOrderExpiryJob() {
    const days = getExpiryDays();
    const selectSql = `
        SELECT o.id, o.buyer_id, o.status, o.total_price, o.quantity, o.created_at,
               f.owner_id AS farmer_id, f.name AS field_name, u.preferred_currency
        FROM orders o
        JOIN fields f ON f.id = o.field_id
        JOIN users u ON u.id = o.buyer_id
        WHERE o.status = 'pending'
          AND o.created_at <= NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY o.created_at ASC
        LIMIT 100
    `;

    const { rows } = await pool.query(selectSql, [days]);
    if (rows.length === 0) {
        return { processed: 0, days };
    }

    let processed = 0;
    for (const row of rows) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const lock = await client.query(
                `SELECT o.id, o.buyer_id, o.status, o.total_price, o.quantity, o.created_at,
                        f.owner_id AS farmer_id, f.name AS field_name, u.preferred_currency
                 FROM orders o
                 JOIN fields f ON f.id = o.field_id
                 JOIN users u ON u.id = o.buyer_id
                 WHERE o.id = $1
                   AND o.status = 'pending'
                   AND o.created_at <= NOW() - ($2::int * INTERVAL '1 day')
                 FOR UPDATE OF o`,
                [row.id, days]
            );

            if (lock.rows.length === 0) {
                await client.query('ROLLBACK');
                continue;
            }

            const order = lock.rows[0];

            await runOrderRefundCoinEffects(order, 'pending', {
                pendingRefundReason: `Auto-cancelled (farmer did not accept within ${days} days): ${order.field_name}`,
            });

            await client.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);

            try {
                await client.query(
                    `UPDATE order_refund_requests
                     SET status = 'rejected',
                         resolved_at = NOW(),
                         farmer_response = $2,
                         resolved_by = NULL
                     WHERE order_id = $1 AND status = 'pending'`,
                    [
                        order.id,
                        `Order expired: farmer did not accept within ${days} days (automatic cancellation).`,
                    ]
                );
            } catch (e) {
                if (e.code !== '42P01') throw e;
            }

            await client.query(
                'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
                [
                    order.buyer_id,
                    `Your order for ${order.field_name} was automatically cancelled: the farmer did not accept it within ${days} days. Your coins have been refunded.`,
                    'info',
                ]
            );
            await client.query(
                'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
                [
                    order.farmer_id,
                    `An order for ${order.field_name} was automatically cancelled — no acceptance within ${days} days. The buyer has been refunded.`,
                    'warning',
                ]
            );

            await client.query('COMMIT');
            processed += 1;
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {
                /* ignore */
            }
            console.error('[expirePendingOrders] failed for order', row.id, err.message);
        } finally {
            client.release();
        }
    }

    if (processed > 0) {
        console.log(`[expirePendingOrders] auto-cancelled ${processed} pending order(s) older than ${days} day(s)`);
    }
    return { processed, days, candidates: rows.length };
}

module.exports = {
    runPendingOrderExpiryJob,
    getExpiryDays,
};
