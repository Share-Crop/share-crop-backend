const express = require('express');
const router = express.Router();
const pool = require('../db');

/**
 * GET /api/deliveries/my
 *
 * Aggregated delivery view for the current authenticated user.
 * - As a buyer: deliveries for orders they placed with mode_of_shipping = 'delivery'
 * - As a farmer: deliveries for orders placed on their fields with mode_of_shipping = 'delivery'
 *
 * Response shape:
 * {
 *   buyer: { upcoming: [...], current: [...], past: [...] },
 *   farmer: { upcoming: [...], current: [...], past: [...] }
 * }
 */
router.get('/my', async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userId = user.id;
    console.log('Delivery API called with userId:', userId);

    // Debug: Check if user has any orders
    const debugOrders = await pool.query('SELECT id, buyer_id, field_id, status, mode_of_shipping FROM orders WHERE buyer_id = $1', [userId]);
    console.log('Orders for userId:', userId, 'Result:', debugOrders.rows);

    // 1. Deliveries where the user is the buyer (ALL orders regardless of shipping mode)
    const buyerResult = await pool.query(`
      SELECT 
        o.id,
        o.quantity,
        o.total_price,
        o.status,
        o.created_at,
        o.selected_harvest_date,
        o.selected_harvest_label,
        o.mode_of_shipping,
        f.id   AS field_id,
        f.name AS field_name,
        f.location,
        f.category AS crop_type,
        f.image AS image_url,
        f.estimated_delivery_days,
        f.owner_id AS farmer_id,
        farmer.name  AS farmer_name,
        farmer.email AS farmer_email
      FROM orders o
      JOIN fields f ON o.field_id = f.id
      LEFT JOIN users farmer ON f.owner_id = farmer.id
      WHERE o.buyer_id = $1
      ORDER BY COALESCE(o.selected_harvest_date, o.created_at) DESC
    `, [userId]);

    // 2. Deliveries where the user is the farmer (ALL orders regardless of shipping mode)
    const farmerResult = await pool.query(`
      SELECT 
        o.id,
        o.quantity,
        o.total_price,
        o.status,
        o.created_at,
        o.selected_harvest_date,
        o.selected_harvest_label,
        o.mode_of_shipping,
        f.id   AS field_id,
        f.name AS field_name,
        f.location,
        f.category AS crop_type,
        f.image AS image_url,
        f.estimated_delivery_days,
        f.owner_id AS farmer_id,
        buyer.name  AS buyer_name,
        buyer.email AS buyer_email
      FROM orders o
      JOIN fields f ON o.field_id = f.id
      LEFT JOIN users buyer ON o.buyer_id = buyer.id
      WHERE f.owner_id = $1
      ORDER BY COALESCE(o.selected_harvest_date, o.created_at) DESC
    `, [userId]);

    const categorizeByDate = (rows) => {
      const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const upcoming = [];
      const past = [];
      const current = [];

      for (const row of rows) {
        const dateRaw = row.selected_harvest_date || row.created_at;
        if (!dateRaw) {
          current.push(row);
          continue;
        }
        const dateStr = typeof dateRaw === 'string'
          ? dateRaw.slice(0, 10)
          : new Date(dateRaw).toISOString().slice(0, 10);

        if (dateStr > todayStr) {
          upcoming.push(row);
        } else if (dateStr < todayStr) {
          past.push(row);
        } else {
          current.push(row);
        }
      }

      return { upcoming, current, past };
    };

    const buyerDeliveries = categorizeByDate(buyerResult.rows);
    const farmerDeliveries = categorizeByDate(farmerResult.rows);

    res.json({
      buyer: buyerDeliveries,
      farmer: farmerDeliveries,
    });
  } catch (err) {
    console.error('Error fetching deliveries:', err.message);
    res.status(500).json({ error: 'Server Error', details: err.message });
  }
});

module.exports = router;

