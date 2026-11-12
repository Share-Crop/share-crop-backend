const pool = require('../../../../db');
const {
  mergeFieldCategories,
  findParentKey,
  hasSubInParent,
} = require('../../categories/fieldCategories');
const { persistTwemojiIconForKey } = require('../../categories/persistTwemojiIcon');
const { resolveEmojiForTitle, twemojiPngUrl } = require('../../categories/subcategoryEmojis');

async function listCategoryRequests(req, res) {
  try {
    const status = (req.query.status || '').trim();
    const params = [];
    const where = [];

    if (status && status !== 'all') {
      params.push(status);
      where.push(`cr.status = $${params.length}`);
    }

    const sql = `
      SELECT
        cr.id,
        cr.title,
        COALESCE(cr.request_type, 'category') AS request_type,
        cr.parent_category,
        cr.emoji,
        cr.status,
        cr.admin_notes,
        cr.requested_by,
        u.name AS requester_name,
        u.email AS requester_email,
        cr.reviewed_by,
        reviewer.name AS reviewer_name,
        cr.reviewed_at,
        cr.created_at
      FROM category_requests cr
      LEFT JOIN users u ON u.id = cr.requested_by
      LEFT JOIN users reviewer ON reviewer.id = cr.reviewed_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY
        CASE cr.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
        cr.created_at DESC
      LIMIT 200
    `;

    const result = await pool.query(sql, params);
    const rows = result.rows.map((row) => {
      const emoji = row.emoji || resolveEmojiForTitle(row.title)?.emoji || null;
      return {
        ...row,
        emoji,
        twemoji_url: emoji ? twemojiPngUrl(emoji) : null,
      };
    });
    res.json(rows);
  } catch (err) {
    console.error('[admin category-requests] list:', err.message);
    res.status(500).json({ error: 'Server Error' });
  }
}

async function updateCategoryRequest(req, res) {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    const action = String(req.body?.action || '').trim();
    const adminNotes =
      req.body?.admin_notes != null ? String(req.body.admin_notes).trim() || null : null;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be "approve" or "reject"' });
    }

    const existing = await pool.query(
      `SELECT id, title, status,
              COALESCE(request_type, 'category') AS request_type,
              parent_category,
              emoji,
              requested_by
       FROM category_requests WHERE id = $1`,
      [id]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const row = existing.rows[0];
    if (row.status !== 'pending') {
      return res.status(400).json({ error: `Request is already ${row.status}` });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const requestType = row.request_type === 'subcategory' ? 'subcategory' : 'category';

    if (action === 'approve') {
      const catalog = await mergeFieldCategories();

      if (requestType === 'category') {
        if (findParentKey(catalog, row.title)) {
          return res.status(409).json({
            error: `Category “${row.title}” already exists in the create-field list`,
          });
        }
        const clash = await pool.query(
          `SELECT id FROM category_requests
           WHERE status = 'approved'
             AND COALESCE(request_type, 'category') = 'category'
             AND lower(trim(title)) = lower(trim($1))
             AND id <> $2
           LIMIT 1`,
          [row.title, id]
        );
        if (clash.rows.length) {
          return res.status(409).json({ error: 'An approved category with this title already exists' });
        }
      } else {
        const parentKey = findParentKey(catalog, row.parent_category);
        if (!parentKey) {
          return res.status(400).json({
            error: `Parent category “${row.parent_category}” is not available. Reject or ask the farmer to resubmit under a valid category.`,
          });
        }
        if (hasSubInParent(catalog, parentKey, row.title)) {
          return res.status(409).json({
            error: `“${row.title}” is already listed under ${parentKey}`,
          });
        }
        const clash = await pool.query(
          `SELECT id FROM category_requests
           WHERE status = 'approved'
             AND request_type = 'subcategory'
             AND lower(trim(parent_category)) = lower(trim($1))
             AND lower(trim(title)) = lower(trim($2))
             AND id <> $3
           LIMIT 1`,
          [parentKey, row.title, id]
        );
        if (clash.rows.length) {
          return res.status(409).json({
            error: `An approved product type “${row.title}” already exists under ${parentKey}`,
          });
        }
      }
    }

    const updated = await pool.query(
      `UPDATE category_requests
       SET status = $1,
           admin_notes = COALESCE($2, admin_notes),
           reviewed_by = $3,
           reviewed_at = NOW()
       WHERE id = $4 AND status = 'pending'
       RETURNING id, title, COALESCE(request_type, 'category') AS request_type,
                 parent_category, emoji, status, admin_notes, reviewed_at, created_at`,
      [newStatus, adminNotes, req.user.id, id]
    );

    if (!updated.rows.length) {
      return res.status(409).json({ error: 'Request was already processed' });
    }

    const saved = updated.rows[0];

    // Permanently store Twemoji PNG URL for the product type (same key Create Field uses)
    if (action === 'approve') {
      try {
        const emojiHint = saved.emoji || resolveEmojiForTitle(saved.title)?.emoji || null;
        await persistTwemojiIconForKey(saved.title, emojiHint, { overwrite: false });
      } catch (iconErr) {
        console.warn('[admin category-requests] icon persist:', iconErr.message);
      }
    }

    // Notify the requester — especially important on rejection with the admin note
    if (row.requested_by) {
      try {
        const reason = adminNotes || saved.admin_notes || null;
        let message;
        if (action === 'reject') {
          const where =
            requestType === 'subcategory' && row.parent_category
              ? `“${row.title}” under ${row.parent_category}`
              : `“${row.title}”`;
          message = reason
            ? `Your category request ${where} was rejected. Reason: ${reason}`
            : `Your category request ${where} was rejected.`;
        } else {
          const where =
            requestType === 'subcategory' && row.parent_category
              ? `“${row.title}” under ${row.parent_category}`
              : `“${row.title}”`;
          message = `Your category request ${where} was approved and is now available when creating a field.`;
        }
        await pool.query(
          `INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)`,
          [row.requested_by, message, 'category_request']
        );
      } catch (notifyErr) {
        console.warn('[admin category-requests] notify requester:', notifyErr.message);
      }
    }

    res.json(saved);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Category title conflict' });
    }
    console.error('[admin category-requests] update:', err.message);
    res.status(500).json({ error: 'Server Error' });
  }
}

module.exports = {
  listCategoryRequests,
  updateCategoryRequest,
};
