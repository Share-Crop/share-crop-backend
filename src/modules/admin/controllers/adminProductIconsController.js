const pool = require('../../../../db');

async function list(req, res) {
  try {
    const r = await pool.query(
      'SELECT category_key, image_url, updated_at FROM product_category_icons ORDER BY category_key'
    );
    const overrides = {};
    r.rows.forEach((row) => {
      if (row.category_key && row.image_url) {
        overrides[row.category_key] = row.image_url;
      }
    });
    res.json({ rows: r.rows, overrides });
  } catch (e) {
    console.error('adminProductIcons list', e);
    res.status(500).json({ error: 'Failed to list product icons' });
  }
}

async function upsert(req, res) {
  try {
    const { category_key, image_url } = req.body || {};
    if (!category_key || typeof category_key !== 'string') {
      return res.status(400).json({ error: 'category_key is required' });
    }
    if (!image_url || typeof image_url !== 'string') {
      return res.status(400).json({ error: 'image_url is required' });
    }
    const key = category_key.trim();
    const url = image_url.trim();
    if (!key || !url) {
      return res.status(400).json({ error: 'category_key and image_url must be non-empty' });
    }
    await pool.query(
      `INSERT INTO product_category_icons (category_key, image_url, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (category_key) DO UPDATE SET image_url = EXCLUDED.image_url, updated_at = now()`,
      [key, url]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('adminProductIcons upsert', e);
    res.status(500).json({ error: 'Failed to save product icon' });
  }
}

async function remove(req, res) {
  try {
    const raw = req.query.key;
    if (!raw || typeof raw !== 'string') {
      return res.status(400).json({ error: 'query key is required' });
    }
    const key = raw.trim();
    await pool.query('DELETE FROM product_category_icons WHERE category_key = $1', [key]);
    res.json({ ok: true });
  } catch (e) {
    console.error('adminProductIcons remove', e);
    res.status(500).json({ error: 'Failed to remove product icon override' });
  }
}

module.exports = { list, upsert, remove };
