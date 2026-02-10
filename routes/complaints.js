const express = require('express');
const router = express.Router();
const pool = require('../db');

/**
 * POST /api/complaints
 * Create a new complaint (for both farmers and buyers)
 * 
 * Body:
 * - created_by: uuid (user ID creating the complaint)
 * - target_type: string ('field', 'order', 'user', 'payment', 'delivery', etc.)
 * - target_id: uuid (ID of the target being complained about)
 * - category: string (optional, e.g., 'Service', 'Quality', 'Delivery', 'Payment', 'Refund', 'Field', 'Order', 'User')
 * - description: string (required, the complaint details/message)
 */
router.post('/', async (req, res) => {
  try {
    const { created_by, target_type, target_id, category, description, complained_against_user_id } = req.body;

    // Validation
    if (!created_by) {
      return res.status(400).json({ error: 'created_by is required' });
    }
    if (!target_type) {
      return res.status(400).json({ error: 'target_type is required' });
    }
    if (!description || description.trim().length === 0) {
      return res.status(400).json({ error: 'description is required and cannot be empty' });
    }

    // Validate target_type
    const validTargetTypes = ['field', 'order', 'user', 'payment', 'delivery', 'service', 'quality', 'refund'];
    const normalizedTargetType = target_type.toLowerCase();
    if (!validTargetTypes.includes(normalizedTargetType)) {
      return res.status(400).json({
        error: `Invalid target_type. Must be one of: ${validTargetTypes.join(', ')}`
      });
    }

    // Verify user exists
    const userCheck = await pool.query('SELECT id, user_type FROM users WHERE id = $1', [created_by]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Validate complained_against_user_id if provided
    if (complained_against_user_id) {
      if (complained_against_user_id === created_by) {
        return res.status(400).json({ error: 'You cannot complain against yourself' });
      }
      const complainedUserCheck = await pool.query('SELECT id FROM users WHERE id = $1', [complained_against_user_id]);
      if (complainedUserCheck.rows.length === 0) {
        return res.status(404).json({ error: 'User to complain against not found' });
      }
    }

    // Target types that require target_id
    const requiresTargetId = ['field', 'order', 'user'];

    // For types that require target_id, validate it exists
    if (requiresTargetId.includes(normalizedTargetType)) {
      if (!target_id || target_id.trim() === '') {
        return res.status(400).json({ error: `target_id is required for target_type: ${target_type}` });
      }

      // Verify target exists based on target_type
      let targetExists = false;
      if (normalizedTargetType === 'field') {
        const fieldCheck = await pool.query('SELECT id FROM fields WHERE id = $1', [target_id]);
        targetExists = fieldCheck.rows.length > 0;
      } else if (normalizedTargetType === 'order') {
        const orderCheck = await pool.query('SELECT id FROM orders WHERE id = $1', [target_id]);
        targetExists = orderCheck.rows.length > 0;
      } else if (normalizedTargetType === 'user') {
        const userTargetCheck = await pool.query('SELECT id FROM users WHERE id = $1', [target_id]);
        targetExists = userTargetCheck.rows.length > 0;
      }

      if (!targetExists) {
        return res.status(404).json({ error: `Target ${target_type} with id ${target_id} not found` });
      }
    }

    // For general complaint types (service, quality, refund, etc.), target_id is optional
    // Use a placeholder UUID if not provided
    const finalTargetId = target_id && target_id.trim() !== ''
      ? target_id
      : '00000000-0000-0000-0000-000000000000'; // Placeholder UUID for general complaints

    // Insert complaint
    const result = await pool.query(
      `INSERT INTO complaints (created_by, target_type, target_id, category, description, status, complained_against_user_id)
       VALUES ($1, $2, $3, $4, $5, 'open', $6)
       RETURNING *`,
      [created_by, normalizedTargetType, finalTargetId, category || null, description.trim(), complained_against_user_id || null]
    );

    const complaint = result.rows[0];

    // Create notification for admin (optional - you might want to notify admins of new complaints)
    // This is optional and can be removed if you don't want notifications

    res.status(201).json({
      id: complaint.id,
      created_by: complaint.created_by,
      target_type: complaint.target_type,
      target_id: complaint.target_id,
      category: complaint.category,
      description: complaint.description,
      status: complaint.status,
      complained_against_user_id: complaint.complained_against_user_id,
      created_at: complaint.created_at,
      updated_at: complaint.updated_at,
      message: 'Complaint submitted successfully'
    });
  } catch (err) {
    console.error('Error creating complaint:', err.message);
    res.status(500).json({ error: 'Server Error', details: err.message });
  }
});

/**
 * GET /api/complaints
 * Get complaints for the authenticated user
 * 
 * Query params:
 * - status: filter by status ('open', 'in_review', 'resolved')
 * - user_id: optional, if provided returns complaints created by that user
 */
router.get('/', async (req, res) => {
  try {
    const { status, user_id, complained_against_user_id } = req.query;
    let query = `
      SELECT 
        c.id,
        c.created_by,
        u.name AS created_by_name,
        u.email AS created_by_email,
        u.user_type AS created_by_type,
        c.category,
        c.target_type,
        c.target_id,
        c.description,
        c.status,
        c.admin_remarks,
        c.refund_coins,
        c.refunded_at,
        COALESCE(c.complained_against_user_id, 
          CASE 
            WHEN c.target_type = 'user' THEN (SELECT id FROM users WHERE id = c.target_id)
            WHEN c.target_type = 'field' THEN (SELECT owner_id FROM fields WHERE id = c.target_id)
            WHEN c.target_type = 'order' THEN (SELECT f.owner_id FROM fields f JOIN orders o ON o.field_id = f.id WHERE o.id = c.target_id)
            ELSE NULL
          END
        ) AS complained_against_user_id,
        c.created_at,
        c.updated_at,
        complained_user.name AS complained_against_user_name,
        complained_user.email AS complained_against_user_email,
        complained_user.user_type AS complained_against_user_type
      FROM complaints c
      LEFT JOIN users u ON u.id = c.created_by
      LEFT JOIN users complained_user ON complained_user.id = (
        COALESCE(c.complained_against_user_id, 
          CASE 
            WHEN c.target_type = 'user' THEN (SELECT id FROM users WHERE id = c.target_id)
            WHEN c.target_type = 'field' THEN (SELECT owner_id FROM fields WHERE id = c.target_id)
            WHEN c.target_type = 'order' THEN (SELECT f.owner_id FROM fields f JOIN orders o ON o.field_id = f.id WHERE o.id = c.target_id)
            ELSE NULL
          END
        )
      )
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;

    if (user_id) {
      paramCount++;
      query += ` AND c.created_by = $${paramCount}`;
      params.push(user_id);
    }

    if (complained_against_user_id) {
      paramCount++;
      query += ` AND c.complained_against_user_id = $${paramCount}`;
      params.push(complained_against_user_id);
    }

    if (status) {
      paramCount++;
      query += ` AND c.status = $${paramCount}`;
      params.push(status);
    }

    query += ' ORDER BY c.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching complaints:', err.message);
    res.status(500).json({ error: 'Server Error', details: err.message });
  }
});

/**
 * GET /api/complaints/:id
 * Get a single complaint by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT 
        c.id,
        c.created_by,
        u.name AS created_by_name,
        u.email AS created_by_email,
        u.user_type AS created_by_type,
        c.category,
        c.target_type,
        c.target_id,
        c.description,
        c.status,
        c.admin_remarks,
        c.refund_coins,
        c.refunded_at,
        COALESCE(c.complained_against_user_id, 
          CASE 
            WHEN c.target_type = 'user' THEN (SELECT id FROM users WHERE id = c.target_id)
            WHEN c.target_type = 'field' THEN (SELECT owner_id FROM fields WHERE id = c.target_id)
            WHEN c.target_type = 'order' THEN (SELECT f.owner_id FROM fields f JOIN orders o ON o.field_id = f.id WHERE o.id = c.target_id)
            ELSE NULL
          END
        ) AS complained_against_user_id,
        c.created_at,
        c.updated_at,
        complained_user.name AS complained_against_user_name,
        complained_user.email AS complained_against_user_email,
        complained_user.user_type AS complained_against_user_type
      FROM complaints c
      LEFT JOIN users u ON u.id = c.created_by
      LEFT JOIN users complained_user ON complained_user.id = (
        COALESCE(c.complained_against_user_id, 
          CASE 
            WHEN c.target_type = 'user' THEN (SELECT id FROM users WHERE id = c.target_id)
            WHEN c.target_type = 'field' THEN (SELECT owner_id FROM fields WHERE id = c.target_id)
            WHEN c.target_type = 'order' THEN (SELECT f.owner_id FROM fields f JOIN orders o ON o.field_id = f.id WHERE o.id = c.target_id)
            ELSE NULL
          END
        )
      )
      WHERE c.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Complaint not found' });
    }

    const complaint = result.rows[0];

    // Fetch optional proof attachments (complaint_proofs table may not exist yet before migration)
    let proofs = [];
    try {
      const proofsResult = await pool.query(
        'SELECT id, file_name, file_url, file_type, created_at FROM complaint_proofs WHERE complaint_id = $1 ORDER BY created_at ASC',
        [id]
      );
      proofs = proofsResult.rows || [];
    } catch (e) {
      if (e.code !== '42P01') throw e; // 42P01 = undefined_table
    }

    // Fetch remarks thread (complaint_remarks may not exist yet before migration)
    let remarks = [];
    try {
      const remarksResult = await pool.query(
        `SELECT r.id, r.complaint_id, r.created_by, r.message, r.created_at,
                u.name AS author_name, u.user_type AS author_type
         FROM complaint_remarks r
         LEFT JOIN users u ON u.id = r.created_by
         WHERE r.complaint_id = $1 ORDER BY r.created_at ASC`,
        [id]
      );
      remarks = remarksResult.rows || [];
    } catch (e) {
      if (e.code !== '42P01') throw e;
    }

    res.json({ ...complaint, proofs, remarks, refund_coins: complaint.refund_coins ?? null, refunded_at: complaint.refunded_at ?? null });
  } catch (err) {
    console.error('Error fetching complaint:', err.message);
    res.status(500).json({ error: 'Server Error', details: err.message });
  }
});

const MAX_PROOFS_PER_COMPLAINT = 5;

/**
 * POST /api/complaints/:id/proofs
 * Add proof attachments (images/docs) to an existing complaint. Max 5 docs per complaint.
 * Allowed: complaint author or admin.
 * Body: { proofs: [ { file_name, file_url, file_type? } ] } or single { file_name, file_url, file_type? }
 */
router.post('/:id/proofs', async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    let list = Array.isArray(body.proofs) ? body.proofs : (body.file_name && body.file_url ? [body] : []);
    if (list.length === 0) {
      return res.status(400).json({ error: 'Provide proofs array or single { file_name, file_url, file_type? }' });
    }

    const complaintResult = await pool.query(
      'SELECT id, created_by FROM complaints WHERE id = $1',
      [id]
    );
    if (complaintResult.rows.length === 0) {
      return res.status(404).json({ error: 'Complaint not found' });
    }
    const complaint = complaintResult.rows[0];
    const createdBy = complaint.created_by;
    const isAuthor = req.user && req.user.id && createdBy === req.user.id;
    const isAdmin = req.user && req.user.user_type === 'admin';
    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ error: 'Only the complaint author or an admin can add proofs' });
    }

    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS n FROM complaint_proofs WHERE complaint_id = $1',
      [id]
    );
    const currentCount = countResult.rows[0]?.n || 0;
    const wouldBe = currentCount + list.length;
    if (currentCount >= MAX_PROOFS_PER_COMPLAINT) {
      return res.status(400).json({ error: `Maximum ${MAX_PROOFS_PER_COMPLAINT} documents per complaint. You already have ${currentCount}.` });
    }
    if (wouldBe > MAX_PROOFS_PER_COMPLAINT) {
      return res.status(400).json({
        error: `Maximum ${MAX_PROOFS_PER_COMPLAINT} documents per complaint. You have ${currentCount}; adding ${list.length} would exceed the limit.`,
        currentCount,
        allowedMore: MAX_PROOFS_PER_COMPLAINT - currentCount,
      });
    }

    const inserted = [];
    for (const p of list) {
      const file_name = p.file_name || 'file';
      const file_url = p.file_url || '';
      const file_type = p.file_type || null;
      if (!file_url) continue;
      const ins = await pool.query(
        `INSERT INTO complaint_proofs (complaint_id, file_name, file_url, file_type)
         VALUES ($1, $2, $3, $4) RETURNING id, file_name, file_url, file_type, created_at`,
        [id, file_name, file_url, file_type]
      );
      if (ins.rows[0]) inserted.push(ins.rows[0]);
    }

    res.status(201).json({ proofs: inserted, totalProofs: currentCount + inserted.length });
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(503).json({ error: 'Complaint proofs not available; run migration 030_complaint_proofs_and_refund' });
    }
    console.error('Error adding complaint proofs:', err.message);
    res.status(500).json({ error: 'Server Error', details: err.message });
  }
});

/**
 * POST /api/complaints/:id/remarks
 * Add a message to the complaint thread (admin or complaint author).
 * Body: { message: string }
 */
router.post('/:id/remarks', async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body || {};
    const msg = typeof message === 'string' ? message.trim() : '';
    if (!msg) {
      return res.status(400).json({ error: 'message is required and cannot be empty' });
    }

    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const complaintResult = await pool.query(
      'SELECT id, created_by FROM complaints WHERE id = $1',
      [id]
    );
    if (complaintResult.rows.length === 0) {
      return res.status(404).json({ error: 'Complaint not found' });
    }
    const complaint = complaintResult.rows[0];
    const isAuthor = complaint.created_by === req.user.id;
    const isAdmin = req.user.user_type === 'admin';
    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ error: 'Only the complaint author or an admin can add remarks' });
    }

    const ins = await pool.query(
      `INSERT INTO complaint_remarks (complaint_id, created_by, message)
       VALUES ($1, $2, $3)
       RETURNING id, complaint_id, created_by, message, created_at`,
      [id, req.user.id, msg]
    );
    const row = ins.rows[0];
    const authorResult = await pool.query(
      'SELECT name, user_type FROM users WHERE id = $1',
      [row.created_by]
    );
    const author = authorResult.rows[0] || {};
    const remark = {
      id: row.id,
      complaint_id: row.complaint_id,
      created_by: row.created_by,
      message: row.message,
      created_at: row.created_at,
      author_name: author.name,
      author_type: author.user_type,
    };
    res.status(201).json(remark);
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(503).json({ error: 'Complaint remarks not available; run migration 031_complaint_remarks' });
    }
    console.error('Error adding complaint remark:', err.message);
    res.status(500).json({ error: 'Server Error', details: err.message });
  }
});

module.exports = router;

