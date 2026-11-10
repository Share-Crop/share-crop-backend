const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../src/middleware/auth/authenticate');
const { mergeFieldCategories } = require('../src/modules/categories/fieldCategories');

/** Public (or any logged-in) catalog: static + approved custom titles. */
router.get('/field-categories', async (_req, res) => {
  try {
    const categories = await mergeFieldCategories();
    res.json({ categories });
  } catch (err) {
    console.error('[field-categories]', err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

router.post('/category-requests', authenticate, async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const title = String(req.body?.title || '').trim().replace(/\s+/g, ' ');
    if (title.length < 2 || title.length > 80) {
      return res.status(400).json({ error: 'Category title must be 2–80 characters' });
    }

    const existingApproved = await pool.query(
      `SELECT id FROM category_requests
       WHERE status = 'approved' AND lower(trim(title)) = lower($1)
       LIMIT 1`,
      [title]
    );
    if (existingApproved.rows.length) {
      return res.status(409).json({
        error: 'That category is already available. Refresh the form to see it in the list.',
      });
    }

    const existingPending = await pool.query(
      `SELECT id, status FROM category_requests
       WHERE status = 'pending' AND lower(trim(title)) = lower($1)
       LIMIT 1`,
      [title]
    );
    if (existingPending.rows.length) {
      return res.status(409).json({
        error: 'A request for this category is already pending admin approval.',
      });
    }

    const insert = await pool.query(
      `INSERT INTO category_requests (title, requested_by, status)
       VALUES ($1, $2, 'pending')
       RETURNING id, title, status, created_at`,
      [title, req.user.id]
    );

    res.status(201).json(insert.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A request for this category already exists' });
    }
    console.error('[category-requests] create:', err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

router.get('/category-requests/mine', authenticate, async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const result = await pool.query(
      `SELECT id, title, status, admin_notes, created_at, reviewed_at
       FROM category_requests
       WHERE requested_by = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json({ requests: result.rows });
  } catch (err) {
    console.error('[category-requests] mine:', err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

module.exports = router;
