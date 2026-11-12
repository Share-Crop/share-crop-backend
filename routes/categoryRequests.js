const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../src/middleware/auth/authenticate');
const {
  mergeFieldCategories,
  findParentKey,
  hasSubInParent,
} = require('../src/modules/categories/fieldCategories');
const { resolveEmojiForTitle } = require('../src/modules/categories/subcategoryEmojis');

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

/** Suggest emoji + Twemoji PNG for a typed product-type / category title. */
router.get('/emoji-suggest', (req, res) => {
  const q = String(req.query.q || req.query.title || '').trim();
  if (q.length < 2) return res.json({ suggestion: null });
  const suggestion = resolveEmojiForTitle(q);
  res.json({ suggestion });
});

router.post('/category-requests', authenticate, async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const requestTypeRaw = String(req.body?.request_type || 'category').trim().toLowerCase();
    const requestType = requestTypeRaw === 'subcategory' ? 'subcategory' : 'category';
    const title = String(req.body?.title || '').trim().replace(/\s+/g, ' ');
    const parentRaw =
      req.body?.parent_category != null ? String(req.body.parent_category).trim().replace(/\s+/g, ' ') : '';
    const bodyEmoji =
      req.body?.emoji != null && String(req.body.emoji).trim()
        ? String(req.body.emoji).trim()
        : null;
    const resolved = resolveEmojiForTitle(title);
    const emoji = bodyEmoji || resolved?.emoji || null;

    if (title.length < 2 || title.length > 80) {
      return res.status(400).json({
        error:
          requestType === 'subcategory'
            ? 'Product type must be 2–80 characters'
            : 'Category title must be 2–80 characters',
      });
    }

    const catalog = await mergeFieldCategories();

    if (requestType === 'category') {
      if (findParentKey(catalog, title)) {
        return res.status(409).json({
          error: 'That category already exists. Refresh the form to see it in the list.',
        });
      }

      const existingApproved = await pool.query(
        `SELECT id FROM category_requests
         WHERE status = 'approved'
           AND COALESCE(request_type, 'category') = 'category'
           AND lower(trim(title)) = lower($1)
         LIMIT 1`,
        [title]
      );
      if (existingApproved.rows.length) {
        return res.status(409).json({
          error: 'That category is already available. Refresh the form to see it in the list.',
        });
      }

      const existingPending = await pool.query(
        `SELECT id FROM category_requests
         WHERE status = 'pending'
           AND COALESCE(request_type, 'category') = 'category'
           AND lower(trim(title)) = lower($1)
         LIMIT 1`,
        [title]
      );
      if (existingPending.rows.length) {
        return res.status(409).json({
          error: 'A request for this category is already pending admin approval.',
        });
      }

      const insert = await pool.query(
        `INSERT INTO category_requests (title, request_type, parent_category, emoji, requested_by, status)
         VALUES ($1, 'category', NULL, $2, $3, 'pending')
         RETURNING id, title, request_type, parent_category, emoji, status, created_at`,
        [title, emoji, req.user.id]
      );
      return res.status(201).json(insert.rows[0]);
    }

    // subcategory under an existing parent
    if (!parentRaw) {
      return res.status(400).json({ error: 'Choose which category this product type belongs to.' });
    }

    const parentKey = findParentKey(catalog, parentRaw);
    if (!parentKey) {
      return res.status(400).json({
        error: 'That parent category is not in the list. Pick an existing category.',
      });
    }

    if (hasSubInParent(catalog, parentKey, title)) {
      return res.status(409).json({
        error: `“${title}” is already listed under ${parentKey}. Refresh the form to see it.`,
      });
    }

    const existingApproved = await pool.query(
      `SELECT id FROM category_requests
       WHERE status = 'approved'
         AND request_type = 'subcategory'
         AND lower(trim(parent_category)) = lower($1)
         AND lower(trim(title)) = lower($2)
       LIMIT 1`,
      [parentKey, title]
    );
    if (existingApproved.rows.length) {
      return res.status(409).json({
        error: `“${title}” is already available under ${parentKey}. Refresh the form to see it.`,
      });
    }

    const existingPending = await pool.query(
      `SELECT id FROM category_requests
       WHERE status = 'pending'
         AND request_type = 'subcategory'
         AND lower(trim(parent_category)) = lower($1)
         AND lower(trim(title)) = lower($2)
       LIMIT 1`,
      [parentKey, title]
    );
    if (existingPending.rows.length) {
      return res.status(409).json({
        error: `A request for “${title}” under ${parentKey} is already pending admin approval.`,
      });
    }

    const insert = await pool.query(
      `INSERT INTO category_requests (title, request_type, parent_category, emoji, requested_by, status)
       VALUES ($1, 'subcategory', $2, $3, $4, 'pending')
       RETURNING id, title, request_type, parent_category, emoji, status, created_at`,
      [title, parentKey, emoji, req.user.id]
    );
    res.status(201).json(insert.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A matching request already exists' });
    }
    if (err.code === '42703') {
      return res.status(503).json({
        error: 'Category request upgrade is not applied yet. Ask an admin to run migrations 056/057.',
      });
    }
    console.error('[category-requests] create:', err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

router.get('/category-requests/mine', authenticate, async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const result = await pool.query(
      `SELECT id, title, COALESCE(request_type, 'category') AS request_type, parent_category, emoji,
              status, admin_notes, created_at, reviewed_at
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
