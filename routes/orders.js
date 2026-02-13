const express = require('express');
const router = express.Router();
const pool = require('../db');
const coinService = require('../src/modules/coins/coinService');
const packageService = require('../src/modules/coins/packageService');

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
                buyer.email as buyer_email
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
                buyer.email as buyer_email
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

        // Must match DB constraint orders_status_check: pending, active, completed, cancelled only
        if (!status || !['pending', 'active', 'completed', 'cancelled'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status. Allowed: pending, active, completed, cancelled' });
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
                const coinAmount = await coinService.calculateCoinCost(order.total_price, order.preferred_currency || 'USD');

                await coinService.refundCoins(order.buyer_id, coinAmount, {
                    reason: `Order Rejected/Cancelled: ${order.field_name}`,
                    refType: 'order',
                    refId: order.id
                });

                // Notification for buyer
                await client.query(
                    'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
                    [order.buyer_id, `Your order for ${order.field_name} was cancelled/rejected. Coins have been refunded.`, 'info']
                );
            }

            // 3. Reversal: active/completed -> cancelled (Deduct from Farmer, Refund Buyer)
            if ((oldStatus === 'active' || oldStatus === 'completed') && status === 'cancelled') {
                const coinAmount = await coinService.calculateCoinCost(order.total_price, order.preferred_currency || 'USD');

                // Deduct from farmer first
                try {
                    await coinService.deductCoins(order.farmer_id, coinAmount, {
                        reason: `Order Cancelled (Reversal): ${order.field_name}`,
                        refType: 'order',
                        refId: order.id
                    });
                } catch (deductErr) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        error: 'Cancellation failed: Insufficient coins in farmer wallet to process refund.',
                        details: deductErr.message
                    });
                }

                // Refund the buyer
                await coinService.refundCoins(order.buyer_id, coinAmount, {
                    reason: `Order Cancelled after acceptance: ${order.field_name}`,
                    refType: 'order',
                    refId: order.id
                });

                // Notifications
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
                    u.email as farmer_email
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
                u.email as farmer_email
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
        const { buyer_id, field_id, quantity, total_price, status = 'pending', selected_harvest_date, selected_harvest_label, mode_of_shipping } = req.body;

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

        // 4. Insert order
        const newOrder = await client.query(
            'INSERT INTO orders (buyer_id, field_id, quantity, total_price, status, selected_harvest_date, selected_harvest_label, mode_of_shipping) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [buyer_id, field_id, quantity, total_price, status, selected_harvest_date, selected_harvest_label, mode_of_shipping]
        );

        const orderId = newOrder.rows[0].id;

        // 5. Create notifications
        await client.query(
            'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
            [buyer_id, `Order placed successfully for ${field_name}. ${coinAmount} coins deducted.`, 'success']
        );

        await client.query(
            'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
            [farmer_id, `New order received for ${field_name}. Accept it to receive your share!`, 'info']
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
        const { buyer_id, field_id, quantity, total_price, status, mode_of_shipping } = req.body;
        if (status != null && !['pending', 'active', 'completed', 'cancelled'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status. Allowed: pending, active, completed, cancelled' });
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

// Delete an order
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deleteOrder = await pool.query('DELETE FROM orders WHERE id = $1 RETURNING *', [id]);
        if (deleteOrder.rows.length === 0) {
            return res.status(404).json('Order not found');
        }
        res.json('Order deleted');
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;