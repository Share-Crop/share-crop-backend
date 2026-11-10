const pool = require('../../../../db');

async function safeCount(sql, fallback = 0) {
  try {
    const result = await pool.query(sql);
    return result.rows[0]?.count ?? fallback;
  } catch (err) {
    if (err && (err.code === '42P01' || err.code === '42703')) return fallback;
    throw err;
  }
}

async function overview(req, res) {
  try {
    const out = {
      newUserRegistrations: 0,
      pendingFarmerApprovals: 0,
      newComplaints: 0,
      pendingCategoryRequests: 0,
      pendingRedemptions: 0,
      totalAttention: 0,
    };

    out.newUserRegistrations = await safeCount(
      "SELECT COUNT(*)::int AS count FROM users WHERE created_at >= NOW() - INTERVAL '24 hours'"
    );
    out.pendingFarmerApprovals = await safeCount(
      "SELECT COUNT(*)::int AS count FROM users WHERE user_type = 'farmer' AND approval_status = 'pending'"
    );
    out.newComplaints = await safeCount(
      "SELECT COUNT(*)::int AS count FROM complaints WHERE status IN ('open','in_review')"
    );
    out.pendingCategoryRequests = await safeCount(
      "SELECT COUNT(*)::int AS count FROM category_requests WHERE status = 'pending'"
    );
    out.pendingRedemptions = await safeCount(
      "SELECT COUNT(*)::int AS count FROM redemption_requests WHERE status IN ('pending','under_review')"
    );

    out.totalAttention =
      Number(out.pendingFarmerApprovals || 0) +
      Number(out.newComplaints || 0) +
      Number(out.pendingCategoryRequests || 0) +
      Number(out.pendingRedemptions || 0);

    res.json(out);
  } catch (err) {
    console.error('[admin notifications overview]', err.message);
    res.status(500).json({ error: 'Server Error' });
  }
}

async function listNewUserRegistrations(req, res) {
  try {
    const { from, to } = req.query;
    const params = [];
    let where = "";
    if (from) { params.push(from); where += (where ? ' AND ' : '') + `created_at >= $${params.length}`; }
    if (to) { params.push(to); where += (where ? ' AND ' : '') + `created_at <= $${params.length}`; }
    const sql = `SELECT id, email, name, user_type, created_at FROM users ${where ? 'WHERE ' + where : ''} ORDER BY created_at DESC LIMIT 500`;
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server Error' });
  }
}

async function listPendingFarmerApprovals(req, res) {
  try {
    const result = await pool.query("SELECT id, name, email, created_at FROM users WHERE user_type = 'farmer' AND approval_status = 'pending' ORDER BY created_at DESC LIMIT 500");
    res.json(result.rows);
  } catch (err) {
    const code = err && err.code;
    if (code === '42703') return res.status(500).json({ error: 'Schema requires users.approval_status' });
    res.status(500).json({ error: 'Server Error' });
  }
}

async function listComplaints(req, res) {
  try {
    const { status, from, to } = req.query;
    const params = [];
    let where = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (from) { params.push(from); where.push(`created_at >= $${params.length}`); }
    if (to) { params.push(to); where.push(`created_at <= $${params.length}`); }
    const sql = `SELECT id, created_by, target_type, target_id, status, created_at, updated_at FROM complaints ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`;
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    const code = err && err.code;
    if (code === '42P01') return res.status(500).json({ error: 'Schema requires complaints table' });
    res.status(500).json({ error: 'Server Error' });
  }
}

module.exports = { overview, listNewUserRegistrations, listPendingFarmerApprovals, listComplaints };
