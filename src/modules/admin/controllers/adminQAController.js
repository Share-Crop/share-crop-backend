const pool = require('../../../../db');

function ensureTable(err, table) {
  if (err && err.code === '42P01') {
    throw Object.assign(new Error(`Schema requires table ${table}`), { status: 500 });
  }
}

async function listComplaints(req, res) {
  try {
    const { status } = req.query;
    let q = `
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
        c.created_at,
        c.updated_at
      FROM complaints c
      LEFT JOIN users u ON u.id = c.created_by
    `;
    const params = [];
    if (status) {
      q += ' WHERE c.status = $1';
      params.push(status);
    }
    q += ' ORDER BY c.updated_at DESC';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) {
    ensureTable(err, 'complaints');
    const statusCode = err.status || 500;
    res.status(statusCode).json({ error: err.message || 'Server Error' });
  }
}

const allowedTransitions = {
  open: new Set(['in_review', 'resolved']),
  in_review: new Set(['resolved']),
  resolved: new Set([]),
};

async function updateComplaintStatus(req, res) {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status, admin_remarks } = req.body || {};
    if (!status) {
      return res.status(400).json({ error: 'Missing status' });
    }
    if (!['open', 'in_review', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    await client.query('BEGIN');
    const pre = await client.query('SELECT status FROM complaints WHERE id = $1 FOR UPDATE', [id]);
    if (pre.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not Found' });
    }
    const current = pre.rows[0].status;
    const allowed = allowedTransitions[current];
    if (!allowed || !allowed.has(status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Invalid transition' });
    }
    await client.query(
      'UPDATE complaints SET status = $2, admin_remarks = $3, updated_at = now() WHERE id = $1',
      [id, status, admin_remarks || null]
    );
    await client.query('COMMIT');
    res.json({ id, status });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    ensureTable(err, 'complaints');
    const statusCode = err.status || 500;
    res.status(statusCode).json({ error: err.message || 'Server Error' });
  } finally {
    client.release();
  }
}

async function updateComplaintRemarks(req, res) {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { remarks } = req.body || {};
    await client.query('BEGIN');
    const pre = await client.query('SELECT id FROM complaints WHERE id = $1 FOR UPDATE', [id]);
    if (pre.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not Found' });
    }
    await client.query(
      'UPDATE complaints SET admin_remarks = $2, updated_at = now() WHERE id = $1',
      [id, remarks || null]
    );
    await client.query('COMMIT');
    res.json({ id, admin_remarks: remarks || null });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    ensureTable(err, 'complaints');
    const statusCode = err.status || 500;
    res.status(statusCode).json({ error: err.message || 'Server Error' });
  } finally {
    client.release();
  }
}

/**
 * POST /api/admin/qa/complaints/:id/refund
 * Credit coins to the complainant (victim) as fraud refund. Admin only.
 * Body: { coins: number }
 */
async function refundComplaint(req, res) {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { coins: amount } = req.body || {};
    const numAmount = typeof amount === 'number' ? amount : (parseInt(amount, 10));
    if (!Number.isInteger(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Invalid or missing coins amount (positive integer required)' });
    }

    await client.query('BEGIN');

    const comp = await client.query(
      'SELECT id, created_by, refunded_at FROM complaints WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (comp.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Complaint not found' });
    }
    const complaint = comp.rows[0];
    if (complaint.refunded_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This complaint has already been refunded' });
    }

    const userId = complaint.created_by;
    const balanceResult = await client.query(
      'SELECT coins FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (balanceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Complainant user not found' });
    }
    const currentCoins = Number(balanceResult.rows[0].coins) || 0;
    const newCoins = currentCoins + numAmount;

    await client.query(
      'UPDATE users SET coins = $1 WHERE id = $2',
      [newCoins, userId]
    );
    await client.query(
      `UPDATE complaints SET refund_coins = $2, refunded_at = now(), status = 'resolved', updated_at = now() WHERE id = $1`,
      [id, numAmount]
    );

    // Mandatory: record in coin_transactions for audit and user history
    await client.query(
      `INSERT INTO coin_transactions (user_id, type, amount, reason, balance_after, ref_type, ref_id)
       VALUES ($1, 'credit', $2, $3, $4, 'complaint', $5)`,
      [userId, numAmount, 'complaint_refund', newCoins, id]
    );

    await client.query('COMMIT');

    const adminId = req.user?.id || null;
    console.log('[refundComplaint] Recorded: complaint_id=%s user_id=%s coins=%s balance_after=%s admin_id=%s',
      id, userId, numAmount, newCoins, adminId || 'n/a');

    res.json({
      id,
      refund_coins: numAmount,
      user_id: userId,
      balance_before: currentCoins,
      balance_after: newCoins,
      message: 'Refund credited to complainant successfully',
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    ensureTable(err, 'complaints');
    const statusCode = err.status || 500;
    res.status(statusCode).json({ error: err.message || 'Server Error' });
  } finally {
    client.release();
  }
}

module.exports = { listComplaints, updateComplaintStatus, updateComplaintRemarks, refundComplaint };
