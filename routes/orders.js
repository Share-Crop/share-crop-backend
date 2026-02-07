const express = require('express');
const router = express.Router();
const pool = require('../db');

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

        const result = await pool.query(
            'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
            [status, id]
        );
        res.json(result.rows[0]);
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
    try {
        console.log('Creating order with data:', req.body);
        const { buyer_id, field_id, quantity, total_price, status = 'pending', selected_harvest_date, selected_harvest_label, mode_of_shipping } = req.body;
        console.log('Extracted values:', { buyer_id, field_id, quantity, total_price, status, selected_harvest_date, selected_harvest_label });
        
        // Now using field_id directly since we dropped the products table
        const newOrder = await pool.query(
            'INSERT INTO orders (buyer_id, field_id, quantity, total_price, status, selected_harvest_date, selected_harvest_label, mode_of_shipping) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [buyer_id, field_id, quantity, total_price, status, selected_harvest_date, selected_harvest_label, mode_of_shipping]
        );
        console.log('Order created successfully:', newOrder.rows[0]);
        
        // Create notifications for both buyer and farmer
        // Get field information for notifications
        const fieldResult = await pool.query(
            'SELECT name as field_name, owner_id as farmer_id FROM fields WHERE id = $1',
            [field_id]
        );
        
        if (fieldResult.rows.length > 0) {
            const { field_name, farmer_id } = fieldResult.rows[0];
            
            // Notification for buyer
            await pool.query(
                'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
                [buyer_id, `Order placed successfully for ${field_name}`, 'success']
            );
            
            // Notification for farmer
            await pool.query(
                'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
                [farmer_id, `New order received for ${field_name}`, 'info']
            );
        }
        
        res.json(newOrder.rows[0]);
    } catch (err) {
        console.error('Error creating order:', err.message);
        console.error('Full error:', err);
        res.status(500).send('Server Error');
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