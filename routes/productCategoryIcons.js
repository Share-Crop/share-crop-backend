const express = require('express');
const pool = require('../db');

const router = express.Router();

/** Public: map category_key -> image_url for map / UI (no auth). */
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT category_key, image_url FROM product_category_icons ORDER BY category_key'
    );
    const overrides = {};
    r.rows.forEach((row) => {
      if (row.category_key && row.image_url) {
        overrides[row.category_key] = row.image_url;
      }
    });
    res.json({ overrides });
  } catch (e) {
    console.error('productCategoryIcons GET', e);
    res.status(500).json({ error: 'Failed to load product icons' });
  }
});

module.exports = router;
