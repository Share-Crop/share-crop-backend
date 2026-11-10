const pool = require('../../../../db');

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
    res.json(result.rows);
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
      `SELECT id, title, status FROM category_requests WHERE id = $1`,
      [id]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (existing.rows[0].status !== 'pending') {
      return res.status(400).json({ error: `Request is already ${existing.rows[0].status}` });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    if (action === 'approve') {
      const clash = await pool.query(
        `SELECT id FROM category_requests
         WHERE status = 'approved' AND lower(trim(title)) = lower(trim($1)) AND id <> $2
         LIMIT 1`,
        [existing.rows[0].title, id]
      );
      if (clash.rows.length) {
        return res.status(409).json({ error: 'An approved category with this title already exists' });
      }
    }

    const updated = await pool.query(
      `UPDATE category_requests
       SET status = $1,
           admin_notes = COALESCE($2, admin_notes),
           reviewed_by = $3,
           reviewed_at = NOW()
       WHERE id = $4 AND status = 'pending'
       RETURNING id, title, status, admin_notes, reviewed_at, created_at`,
      [newStatus, adminNotes, req.user.id, id]
    );

    if (!updated.rows.length) {
      return res.status(409).json({ error: 'Request was already processed' });
    }

    res.json(updated.rows[0]);
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
