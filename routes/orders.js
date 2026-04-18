const express = require('express');
const router = express.Router();
const pool = require('../db');
const coinService = require('../src/modules/coins/coinService');
const { runOrderRefundCoinEffects } = require('../src/modules/orders/orderRefundEffects');
const { canSetShippedOrCompletedByHarvest } = require('../src/modules/orders/harvestDateGate');

const pendingRefundIdSql = `(SELECT r.id FROM order_refund_requests r WHERE r.order_id = o.id AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 1)`;
const pendingRefundReasonSql = `(SELECT r.reason FROM order_refund_requests r WHERE r.order_id = o.id AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 1)`;

const ORDER_STATUSES = ['pending', 'active', 'shipped', 'completed', 'cancelled'];

/** Enforce a sensible lifecycle; admins may bypass via caller. */
function validateOrderStatusTransition(oldStatus, newStatus) {
    if (oldStatus === newStatus) return { ok: true };
    if (oldStatus === 'cancelled') {
        return { ok: false, error: 'Cannot change the status of a cancelled order.' };
    }
    const edges = {
        pending: ['active', 'cancelled'],
        active: ['shipped', 'completed', 'cancelled'],
        shipped: ['active', 'completed', 'cancelled'],
        completed: ['cancelled'],
    };
    const allowed = edges[oldStatus];
    if (!allowed || !allowed.includes(newStatus)) {
        return {
            ok: false,
            error: `Invalid status change (${oldStatus} → ${newStatus}). Typical flow: Pending → Active → Shipped → Completed.`,
        };
    }
    return { ok: true };
}

// Get all orders (filtered by user role, admin sees all)
router.get('/', async (req, res) => {
    try {
        const { buyer_id, farmer_id } = req.query;
        const user = req.user; // From attachUser middleware

        // Admin can see all orders (or use query params for filtering)
        if (user && user.user_type === 'admin') {
            if (buyer_id) {
                // Admin filtering by buyer
                const orders = await pool.query(
                    'SELECT * FROM orders WHERE buyer_id = $1 ORDER BY created_at DESC',
                    [buyer_id]
                );
                return res.json(orders.rows);
            } else if (farmer_id) {
                // Admin filtering by farmer (orders on farmer's fields)
                const orders = await pool.query(`
                    SELECT o.* FROM orders o
                    JOIN fields f ON o.field_id = f.id
                    WHERE f.owner_id = $1
                    ORDER BY o.created_at DESC
                `, [farmer_id]);
                return res.json(orders.rows);
            } else {
                // Admin sees all orders
                const allOrders = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
                return res.json(allOrders.rows);
            }
        }

        // Buyer sees only their orders
        if (user && user.user_type === 'buyer') {
            const buyerOrders = await pool.query(
                'SELECT * FROM orders WHERE buyer_id = $1 ORDER BY created_at DESC',
                [user.id]
            );
            return res.json(buyerOrders.rows);
        }

        // Farmer sees orders on their fields (use farmer-orders endpoint for better data)
        if (user && user.user_type === 'farmer') {
            const farmerOrders = await pool.query(`
                SELECT o.* FROM orders o
                JOIN fields f ON o.field_id = f.id
                WHERE f.owner_id = $1
                ORDER BY o.created_at DESC
            `, [user.id]);
            return res.json(farmerOrders.rows);
        }

        // No user or unknown role - return empty or require authentication
        if (!user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Fallback: return empty array for unknown roles
        res.json([]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Get orders for farmer's fields (orders placed by buyers on farmer's fields)
router.get('/farmer-orders', async (req, res) => {
    try {
        const { farmerId } = req.query;
        const user = req.user; // From attachUser middleware

        // If farmerId not provided, use authenticated user's ID
        const targetFarmerId = farmerId || (user && user.user_type === 'farmer' ? user.id : null);

        if (!targetFarmerId) {
            return res.status(400).json({ error: 'Farmer ID is required' });
        }

        // Check authorization: farmer can only see their own orders, admin can see any
        if (user && user.user_type !== 'admin' && user.id !== targetFarmerId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const farmerOrders = await pool.query(`
            SELECT 
                o.id,
                o.quantity,
                o.total_price,
                o.status,
                o.created_at,
                o.selected_harvest_date,
                o.selected_harvest_label,
                o.mode_of_shipping,
                o.notes,
                f.id as field_id,
                f.name as field_name,
                f.location,
                f.category as crop_type,
                f.available_area,
                f.total_area,
                f.price_per_m2,
                f.image as image_url,
                f.owner_id as farmer_id,
                buyer.name as buyer_name,
                buyer.email as buyer_email,
                ${pendingRefundIdSql} AS pending_refund_request_id,
                ${pendingRefundReasonSql} AS pending_refund_request_reason
            FROM orders o
            JOIN fields f ON o.field_id = f.id
            LEFT JOIN users buyer ON o.buyer_id = buyer.id
            WHERE f.owner_id = $1
            ORDER BY o.created_at DESC
        `, [targetFarmerId]);

        res.json(farmerOrders.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Get orders for a specific farmer with full details (orders received on their fields) - same shape as buyer endpoint
router.get('/farmer/:farmerId', async (req, res) => {
    try {
        const { farmerId } = req.params;
        const user = req.user;

        if (user && user.user_type !== 'admin' && user.id !== farmerId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const farmerOrders = await pool.query(`
            SELECT 
                o.id,
                o.quantity,
                o.total_price,
                o.status,
                o.created_at,
                o.selected_harvest_date,
                o.selected_harvest_label,
                o.mode_of_shipping,
                o.notes,
                f.id as field_id,
                f.name as field_name,
                f.location,
                f.category as crop_type,
                f.available_area,
                f.total_area,
                f.price_per_m2,
                f.image as image_url,
                f.owner_id as farmer_id,
                buyer.name as buyer_name,
                buyer.email as buyer_email,
                ${pendingRefundIdSql} AS pending_refund_request_id,
                ${pendingRefundReasonSql} AS pending_refund_request_reason
            FROM orders o
            JOIN fields f ON o.field_id = f.id
            LEFT JOIN users buyer ON o.buyer_id = buyer.id
            WHERE f.owner_id = $1
            ORDER BY o.created_at DESC
        `, [farmerId]);

        res.json(farmerOrders.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Update only order status (for farmer workflow)
router.put('/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const user = req.user;

        if (!status || !ORDER_STATUSES.includes(status)) {
            return res.status(400).json({
                error: `Invalid status. Allowed: ${ORDER_STATUSES.join(', ')}`,
            });
        }

        const orderResult = await pool.query(
            'SELECT o.id, f.owner_id as farmer_id FROM orders o JOIN fields f ON o.field_id = f.id WHERE o.id = $1',
            [id]
        );
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const { farmer_id } = orderResult.rows[0];

        if (user && user.user_type !== 'admin' && user.id !== farmer_id) {
            return res.status(403).json({ error: 'Only the field owner or admin can update order status' });
        }

        // Get full order details for coin operations
        const orderFullResult = await pool.query(
            `SELECT o.*, f.owner_id as farmer_id, f.name as field_name, u.preferred_currency 
             FROM orders o 
             JOIN fields f ON o.field_id = f.id 
             JOIN users u ON o.buyer_id = u.id
             WHERE o.id = $1`,
            [id]
        );
        const order = orderFullResult.rows[0];
        const oldStatus = order.status;

        const transition = validateOrderStatusTransition(oldStatus, status);
        if (user && user.user_type !== 'admin' && !transition.ok) {
            return res.status(400).json({ error: transition.error });
        }

        if (
            ['shipped', 'completed'].includes(status) &&
            user &&
            user.user_type !== 'admin' &&
            !canSetShippedOrCompletedByHarvest(order)
        ) {
            return res.status(400).json({
                error:
                    'Shipped and Completed are only available on or after the order harvest date. The order must include a selected harvest date.',
            });
        }

        // Atomic update with coin logic
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Accepted: pending -> active (Credit Farmer)
            if (oldStatus === 'pending' && status === 'active') {
                const coinAmount = await coinService.calculateCoinCost(order.total_price, order.preferred_currency || 'USD');

                await coinService.creditCoins(order.farmer_id, coinAmount, {
                    reason: `Order Accepted: ${order.quantity}m² of ${order.field_name}`,
                    refType: 'order',
                    refId: order.id
                });

                // Notification for buyer
                await client.query(
                    'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
                    [order.buyer_id, `Your order for ${order.field_name} has been accepted by the farmer!`, 'success']
                );
            }

            // 2. Rejected/Cancelled: pending -> cancelled (Refund Buyer)
            if (oldStatus === 'pending' && status === 'cancelled') {
                await runOrderRefundCoinEffects(order, 'pending');

                await client.query(
                    'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
                    [order.buyer_id, `Your order for ${order.field_name} was cancelled/rejected. Coins have been refunded.`, 'info']
                );
            }

            // Active → Shipped (no coin change; farmer already paid at Active)
            if (oldStatus === 'active' && status === 'shipped') {
                await client.query(
                    'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
                    [
                        order.buyer_id,
                        `Your order for ${order.field_name} has been marked as shipped by the farmer.`,
                        'info',
                    ]
                );
            }

            // Shipped → Completed
            if (oldStatus === 'shipped' && status === 'completed') {
                await client.query(
                    'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
                    [
                        order.buyer_id,
                        `Your order for ${order.field_name} is now completed. Thank you for your purchase!`,
                        'success',
                    ]
                );
            }

            // 3. Reversal: active/shipped/completed -> cancelled (Deduct from Farmer, Refund Buyer)
            if ((oldStatus === 'active' || oldStatus === 'shipped' || oldStatus === 'completed') && status === 'cancelled') {
                try {
                    await runOrderRefundCoinEffects(order, oldStatus);
                } catch (deductErr) {
                    await client.query('ROLLBACK');
                    const msg = deductErr.message || '';
                    if (msg.includes('Insufficient coins')) {
                        return res.status(400).json({
                            error: 'Cancellation failed: Insufficient coins in farmer wallet to process refund.',
                            details: msg
                        });
                    }
                    throw deductErr;
                }

                await client.query(
                    'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
                    [order.farmer_id, `Order for ${order.field_name} was cancelled. Coins were deducted and returned to buyer.`, 'warning']
                );

                await client.query(
                    'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
                    [order.buyer_id, `Your order for ${order.field_name} was cancelled. Coins have been refunded to your wallet.`, 'info']
                );
            }

            // Update order status
            const result = await client.query(
                'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
                [status, id]
            );

            await client.query('COMMIT');
            res.json(result.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Get orders for current authenticated user (my-orders) - MUST come before /:id route
router.get('/my-orders', async (req, res) => {
    try {
        const user = req.user; // From attachUser middleware

        if (!user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Buyer sees their orders
        if (user.user_type === 'buyer') {
            const buyerOrders = await pool.query(`
                SELECT 
                    o.id,
                    o.quantity,
                    o.total_price,
                    o.status,
                    o.created_at,
                    o.selected_harvest_date,
                    o.selected_harvest_label,
                    o.mode_of_shipping,
                    f.id as field_id,
                    f.name as field_name,
                    f.location,
                    f.category as crop_type,
                    f.available_area,
                    f.total_area,
                    f.price_per_m2,
                    f.image as image_url,
                    f.owner_id as farmer_id,
                    u.name as farmer_name,
                    u.email as farmer_email,
                    ${pendingRefundIdSql} AS pending_refund_request_id,
                    ${pendingRefundReasonSql} AS pending_refund_request_reason
                FROM orders o
                JOIN fields f ON o.field_id = f.id
                LEFT JOIN users u ON f.owner_id = u.id
                WHERE o.buyer_id = $1
                ORDER BY o.created_at DESC
            `, [user.id]);
            return res.json(buyerOrders.rows);
        }

        // For other roles, return empty or use appropriate endpoint
        res.json([]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Get orders for a specific buyer with field details - MUST come before /:id route
router.get('/buyer/:buyerId', async (req, res) => {
    try {
        const { buyerId } = req.params;
        const user = req.user; // From attachUser middleware

        // Check authorization: buyer can only see their own orders, admin can see any
        if (user && user.user_type !== 'admin' && user.id !== buyerId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const buyerOrders = await pool.query(`
            SELECT 
                o.id,
                o.quantity,
                o.total_price,
                o.status,
                o.created_at,
                o.selected_harvest_date,
                o.selected_harvest_label,
                o.mode_of_shipping,
                f.id as field_id,
                f.name as field_name,
                f.location,
                f.category as crop_type,
                f.available_area,
                f.total_area,
                f.price_per_m2,
                f.image as image_url,
                f.owner_id as farmer_id,
                u.name as farmer_name,
                u.email as farmer_email,
                ${pendingRefundIdSql} AS pending_refund_request_id,
                ${pendingRefundReasonSql} AS pending_refund_request_reason
            FROM orders o
            JOIN fields f ON o.field_id = f.id
            LEFT JOIN users u ON f.owner_id = u.id
            WHERE o.buyer_id = $1
            ORDER BY o.created_at DESC
        `, [buyerId]);

        res.json(buyerOrders.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// --- Refund requests (buyer asks; farmer approves / rejects) — register before GET /:id ---

router.get('/refund-requests/mine', async (req, res) => {
    try {
        const user = req.user;
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        if (user.user_type !== 'buyer' && user.user_type !== 'admin') {
            return res.status(403).json({ error: 'Only buyers can list their refund requests' });
        }
        const targetBuyer = user.user_type === 'admin' && req.query.buyer_id ? req.query.buyer_id : user.id;
        const r = await pool.query(
            `SELECT r.id, r.order_id, r.status, r.reason, r.farmer_response, r.created_at, r.resolved_at,
                    o.status AS order_status, o.quantity, o.total_price, f.name AS field_name
             FROM order_refund_requests r
             JOIN orders o ON o.id = r.order_id
             JOIN fields f ON f.id = o.field_id
             WHERE r.buyer_id = $1
             ORDER BY r.created_at DESC`,
            [targetBuyer]
        );
        res.json(r.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server Error', details: err.message });
    }
});

router.get('/refund-requests/incoming', async (req, res) => {
    try {
        const user = req.user;
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        if (user.user_type !== 'farmer' && user.user_type !== 'admin') {
            return res.status(403).json({ error: 'Only farmers can list incoming refund requests' });
        }
        const farmerId = user.user_type === 'admin' && req.query.farmer_id ? req.query.farmer_id : user.id;
        const r = await pool.query(
            `SELECT r.id, r.order_id, r.status, r.reason, r.created_at, r.buyer_id,
                    o.status AS order_status, o.quantity, o.total_price, o.mode_of_shipping,
                    f.name AS field_name, f.id AS field_id,
                    buyer.name AS buyer_name, buyer.email AS buyer_email
             FROM order_refund_requests r
             JOIN orders o ON o.id = r.order_id
             JOIN fields f ON f.id = o.field_id
             JOIN users buyer ON buyer.id = o.buyer_id
             WHERE r.status = 'pending' AND f.owner_id = $1
             ORDER BY r.created_at ASC`,
            [farmerId]
        );
        res.json(r.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server Error', details: err.message });
    }
});

router.patch('/refund-requests/:requestId', async (req, res) => {
    const client = await pool.connect();
    try {
        const user = req.user;
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        const { requestId } = req.params;
        const { action, farmer_response } = req.body || {};
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: 'Body must include action: "approve" or "reject"' });
        }

        const reqRow = await client.query(
            `SELECT r.*, o.status AS order_status, o.buyer_id, o.field_id, o.quantity, o.total_price,
                    f.owner_id AS farmer_id, f.name AS field_name, u.preferred_currency
             FROM order_refund_requests r
             JOIN orders o ON o.id = r.order_id
             JOIN fields f ON f.id = o.field_id
             JOIN users u ON o.buyer_id = u.id
             WHERE r.id = $1`,
            [requestId]
        );
        if (reqRow.rows.length === 0) {
            return res.status(404).json({ error: 'Refund request not found' });
        }
        const row = reqRow.rows[0];
        if (user.user_type !== 'admin' && user.id !== row.farmer_id) {
            return res.status(403).json({ error: 'Only the field owner can resolve this request' });
        }
        if (row.status !== 'pending') {
            return res.status(400).json({ error: 'This request has already been resolved' });
        }
        if (row.order_status === 'cancelled') {
            return res.status(400).json({ error: 'Order is already cancelled' });
        }

        const order = {
            id: row.order_id,
            buyer_id: row.buyer_id,
            farmer_id: row.farmer_id,
            total_price: row.total_price,
            preferred_currency: row.preferred_currency,
            field_name: row.field_name,
            quantity: row.quantity,
        };
        const oldStatus = row.order_status;
        const note =
            farmer_response == null || farmer_response === ''
                ? null
                : String(farmer_response).trim().slice(0, 4000);

        if (action === 'reject') {
            await client.query(
                `UPDATE order_refund_requests
                 SET status = 'rejected', resolved_at = now(), resolved_by = $1, farmer_response = $2
                 WHERE id = $3`,
                [user.id, note, requestId]
            );
            await client.query(
                'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
                [
                    row.buyer_id,
                    `Your refund request for ${row.field_name} was declined by the farmer.${note ? ` Note: ${note}` : ''}`,
                    'warning',
                ]
            );
            return res.json({ ok: true, status: 'rejected' });
        }

        // approve
        await client.query('BEGIN');
        try {
            await runOrderRefundCoinEffects(order, oldStatus);
        } catch (coinErr) {
            await client.query('ROLLBACK');
            const msg = coinErr.message || '';
            if (msg.includes('Insufficient coins')) {
                return res.status(400).json({
                    error: 'Cannot approve refund: insufficient coins in your wallet to reverse this order.',
                    details: msg,
                });
            }
            if (coinErr.code === 'INVALID_REFUND_STATUS') {
                return res.status(400).json({ error: msg });
            }
            throw coinErr;
        }

        await client.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [row.order_id]);
        await client.query(
            `UPDATE order_refund_requests
             SET status = 'approved', resolved_at = now(), resolved_by = $1, farmer_response = $2
             WHERE id = $3`,
            [user.id, note, requestId]
        );

        await client.query(
            'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
            [
                row.buyer_id,
                `Your refund request for ${row.field_name} was approved. Coins have been returned to your wallet and the order is cancelled.`,
                'success',
            ]
        );
        await client.query(
            'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
            [
                row.farmer_id,
                `You approved a refund for ${row.field_name}. The order is cancelled and coins were adjusted.`,
                'info',
            ]
        );

        await client.query('COMMIT');
        res.json({ ok: true, status: 'approved', order_id: row.order_id });
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {
            /* ignore */
        }
        console.error(err.message);
        res.status(500).json({ error: 'Server Error', details: err.message });
    } finally {
        client.release();
    }
});

router.post('/:id/refund-requests', async (req, res) => {
    try {
        const user = req.user;
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        if (user.user_type !== 'buyer') {
            return res.status(403).json({ error: 'Only buyers can request a refund' });
        }

        const { id: orderId } = req.params;
        const reasonRaw = req.body?.reason;
        const reason =
            reasonRaw == null || reasonRaw === '' ? null : String(reasonRaw).trim().slice(0, 4000);

        const orderResult = await pool.query(
            `SELECT o.*, f.owner_id AS farmer_id, f.name AS field_name
             FROM orders o
             JOIN fields f ON f.id = o.field_id
             WHERE o.id = $1`,
            [orderId]
        );
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const o = orderResult.rows[0];
        if (String(o.buyer_id) !== String(user.id)) {
            return res.status(403).json({ error: 'You can only request a refund for your own orders' });
        }
        if (o.status === 'cancelled') {
            return res.status(400).json({ error: 'This order is already cancelled' });
        }
        // Buyer refund requests only after farmer accepted (coins already escrowed / farmer paid).
        // Pending orders: farmer decline/cancel already refunds — no buyer refund request needed.
        if (!['active', 'shipped', 'completed'].includes(o.status)) {
            return res.status(400).json({
                error:
                    'Refund requests are only available after the farmer has accepted the order (Active, Shipped, or Completed). If the order is still pending, wait for the farmer; if they decline, your coins are refunded automatically.',
            });
        }

        const dup = await pool.query(
            `SELECT id FROM order_refund_requests WHERE order_id = $1 AND status = 'pending' LIMIT 1`,
            [orderId]
        );
        if (dup.rows.length > 0) {
            return res.status(409).json({ error: 'A pending refund request already exists for this order' });
        }

        const ins = await pool.query(
            `INSERT INTO order_refund_requests (order_id, buyer_id, status, reason)
             VALUES ($1, $2, 'pending', $3)
             RETURNING *`,
            [orderId, o.buyer_id, reason]
        );

        await pool.query(
            'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
            [
                o.farmer_id,
                `Buyer requested a refund for order on ${o.field_name}.${reason ? ` Message: ${reason}` : ''} Review it in your orders.`,
                'warning',
            ]
        );

        res.status(201).json(ins.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server Error', details: err.message });
    }
});

// Get a single order by ID - MUST come last (after all specific routes)
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const order = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
        if (order.rows.length === 0) {
            return res.status(404).json('Order not found');
        }
        res.json(order.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Create a new order
router.post('/', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Creating order with data:', req.body);
        const {
            buyer_id,
            field_id,
            quantity,
            total_price,
            selected_harvest_date,
            selected_harvest_label,
            mode_of_shipping,
            notes: notesRaw,
        } = req.body;
        const insertStatus = 'pending';
        const notes =
            notesRaw == null || notesRaw === ''
                ? null
                : String(notesRaw).trim().slice(0, 8000);

        // 1. Get user preferences and field info
        const userResult = await client.query('SELECT preferred_currency FROM users WHERE id = $1', [buyer_id]);
        const userCurrency = userResult.rows[0]?.preferred_currency || 'USD';

        const fieldResult = await client.query(
            'SELECT name as field_name, owner_id as farmer_id FROM fields WHERE id = $1',
            [field_id]
        );

        if (fieldResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Field not found' });
        }

        const { field_name, farmer_id } = fieldResult.rows[0];

        // 2. Prevent purchasing from own farm
        if (buyer_id === farmer_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'You cannot purchase from your own farm' });
        }

        // 3. Deduct coins from buyer
        const coinAmount = await coinService.calculateCoinCost(total_price, userCurrency);

        // Use a sub-transaction logic or just call service and catch
        try {
            await coinService.deductCoins(buyer_id, coinAmount, {
                reason: `Order: ${quantity}m² of ${field_name}`,
                refType: 'order',
                refId: null // We'll update this if possible or just rely on the link in orders
            });
        } catch (coinErr) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: coinErr.message });
        }

        // 4. Insert order (notes = delivery address / checkout details from client)
        const newOrder = await client.query(
            `INSERT INTO orders (
                buyer_id, field_id, quantity, total_price, status,
                selected_harvest_date, selected_harvest_label, mode_of_shipping, notes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [
                buyer_id,
                field_id,
                quantity,
                total_price,
                insertStatus,
                selected_harvest_date,
                selected_harvest_label,
                mode_of_shipping,
                notes,
            ]
        );

        const orderId = newOrder.rows[0].id;

        const deliverySnippet = (() => {
            if (!notes || String(mode_of_shipping || '').toLowerCase() !== 'delivery') return '';
            const m =
                notes.match(/\|\s*Address:\s*(.+)$/i) ||
                notes.match(/\|\s*Deliver to:\s*(.+)$/i) ||
                notes.match(/Address:\s*(.+)$/i) ||
                notes.match(/Deliver to:\s*(.+)$/i);
            const raw = m ? m[1].trim() : '';
            if (!raw) return '';
            return raw.length > 220 ? `${raw.slice(0, 217)}…` : raw;
        })();

        const farmerMessage =
            deliverySnippet
                ? `New order received for ${field_name}. Delivery to: ${deliverySnippet}`
                : `New order received for ${field_name}. Accept it to receive your share!`;

        // 5. Create notifications
        await client.query(
            'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
            [buyer_id, `Order placed successfully for ${field_name}. ${coinAmount} coins deducted.`, 'success']
        );

        await client.query(
            'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
            [farmer_id, farmerMessage, 'info']
        );

        await client.query('COMMIT');
        res.json(newOrder.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error creating order:', err.message);
        res.status(500).json({ error: 'Server Error', details: err.message });
    } finally {
        client.release();
    }
});

// Update an order
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const user = req.user;
        const { buyer_id, field_id, quantity, total_price, status, mode_of_shipping } = req.body;
        if (status != null && !ORDER_STATUSES.includes(status)) {
            return res.status(400).json({
                error: `Invalid status. Allowed: ${ORDER_STATUSES.join(', ')}`,
            });
        }

        const existing = await pool.query('SELECT status FROM orders WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        if (existing.rows[0].status === 'cancelled' && user?.user_type !== 'admin') {
            return res.status(400).json({ error: 'Cannot modify a cancelled order.' });
        }

        const result = await pool.query(
            'UPDATE orders SET buyer_id = $1, field_id = $2, quantity = $3, total_price = $4, status = $5, mode_of_shipping = $6 WHERE id = $7 RETURNING *',
            [buyer_id, field_id, quantity, total_price, status, mode_of_shipping, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Delete/hard-remove orders is disabled: buyers use refund requests; farmers cancel via status.
router.delete('/:id', async (req, res) => {
    return res.status(403).json({
        error:
            'Removing orders this way is disabled. As a buyer, request a refund for the farmer to review. Farmers may set the order to Cancelled or approve refund requests from the orders screen.',
    });
});

module.exports = router;