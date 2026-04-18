const express = require('express');
const router = express.Router();
const pool = require('../db');
const { attachGalleryToFieldRows } = require('./fieldHelpers');

/**
 * Public farmer storefront: trust-focused profile + active public fields.
 * GET /api/farmers/:id/public-profile
 */
router.get('/:id/public-profile', async (req, res) => {
  try {
    const { id } = req.params;
    const userResult = await pool.query(
      `SELECT id, name, user_type, profile_image_url, created_at
       FROM users WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }
    const u = userResult.rows[0];
    if (String(u.user_type || '').toLowerCase() !== 'farmer') {
      return res.status(404).json({ error: 'Profile not available' });
    }

    const fieldsResult = await pool.query(
      `SELECT
         f.id,
         f.name,
         f.description,
         f.short_description,
         f.image,
         f.location,
         f.subcategory,
         f.category,
         f.total_area,
         f.price_per_m2,
         f.rating,
         f.reviews,
         f.harvest_dates,
         f.coordinates
       FROM fields f
       WHERE f.owner_id = $1
         AND (f.available IS NULL OR f.available = true)
         AND (
           f.harvest_dates IS NULL
           OR f.harvest_dates = '[]'::jsonb
           OR f.harvest_dates = 'null'::jsonb
           OR (
             SELECT COUNT(*)::int
             FROM jsonb_array_elements(f.harvest_dates) AS hd
             WHERE (hd->>'date')::date >= CURRENT_DATE
           ) > 0
         )
       ORDER BY f.created_at DESC
       LIMIT 100`,
      [id]
    );

    await attachGalleryToFieldRows(fieldsResult.rows);

    res.json({
      farmer: {
        id: u.id,
        name: u.name,
        profile_image_url: u.profile_image_url,
        member_since: u.created_at,
      },
      fields: fieldsResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
