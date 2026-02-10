const express = require('express');
const router = express.Router();
const pool = require('../db'); // Assuming db.js is in the parent directory

// Get all users with enhanced stats
router.get('/', async (req, res) => {
  try {
    const { includeStats } = req.query; // Optional query param to include stats

    if (includeStats === 'true') {
      // Enhanced query with statistics
      const sql = `
        SELECT 
          u.id,
          u.email,
          u.name,
          u.user_type,
          u.coins,
          u.created_at,
          u.is_active,
          u.approval_status,
          u.approval_reason,
          u.documents_json,
          u.profile_image_url,
          (SELECT json_agg(d.*) FROM user_documents d WHERE d.user_id = u.id) as uploaded_documents,
          -- Farmer stats
          CASE 
            WHEN u.user_type = 'farmer' THEN (
              SELECT COUNT(*)::int FROM fields f WHERE f.owner_id = u.id
            )
            ELSE NULL
          END AS fields_count,
          CASE 
            WHEN u.user_type = 'farmer' THEN (
              SELECT COUNT(*)::int FROM farms fm WHERE fm.owner_id = u.id
            )
            ELSE NULL
          END AS farms_count,
          CASE 
            WHEN u.user_type = 'farmer' THEN (
              SELECT COUNT(*)::int 
              FROM orders o 
              JOIN fields f ON f.id = o.field_id 
              WHERE f.owner_id = u.id
            )
            ELSE NULL
          END AS orders_received,
          CASE 
            WHEN u.user_type = 'farmer' THEN (
              SELECT COALESCE(SUM(o.total_price), 0)::float
              FROM orders o 
              JOIN fields f ON f.id = o.field_id 
              WHERE f.owner_id = u.id
            )
            ELSE NULL
          END AS total_revenue,
          CASE 
            WHEN u.user_type = 'farmer' THEN (
              SELECT COALESCE(AVG(f.rating), 0)::float
              FROM fields f 
              WHERE f.owner_id = u.id
            )
            ELSE NULL
          END AS avg_rating,
          -- Buyer stats
          CASE 
            WHEN u.user_type = 'buyer' THEN (
              SELECT COUNT(*)::int FROM orders o WHERE o.buyer_id = u.id
            )
            ELSE NULL
          END AS orders_placed,
          CASE 
            WHEN u.user_type = 'buyer' THEN (
              SELECT COALESCE(SUM(o.total_price), 0)::float
              FROM orders o 
              WHERE o.buyer_id = u.id
            )
            ELSE NULL
          END AS total_spent
        FROM users u
        ORDER BY u.created_at DESC
      `;
      const result = await pool.query(sql);
      res.json(result.rows);
    } else {
      // Basic query without password
      const allUsers = await pool.query(`
        SELECT 
          id, email, name, user_type, coins, created_at, 
          is_active, approval_status, approval_reason, documents_json, profile_image_url,
          (SELECT json_agg(d.*) FROM user_documents d WHERE d.user_id = id) as uploaded_documents
        FROM users
        ORDER BY created_at DESC
      `);
      res.json(allUsers.rows);
    }
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Get user names only (for security - no sensitive data)
// This endpoint returns only: id, name, user_type
// Must be defined BEFORE /:id route to avoid route conflicts
router.get('/names', async (req, res) => {
  try {
    const { search } = req.query;
    let query = 'SELECT id, name, user_type, profile_image_url FROM users';
    const params = [];

    if (search && search.trim().length >= 2) {
      query += ' WHERE name ILIKE $1';
      params.push(`%${search.trim()}%`);
    }

    query += ' ORDER BY name ASC LIMIT 50'; // Limit results for performance

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching user names:', err.message);
    res.status(500).json({ error: 'Failed to fetch user names' });
  }
});

// Get a single user by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (user.rows.length === 0) {
      return res.status(404).json('User not found');
    }
    res.json(user.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Get a single user by ID with stats
router.get('/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    const sql = `
        SELECT 
          u.id,
          u.email,
          u.name,
          u.user_type,
          u.coins,
          u.created_at,
          u.is_active,
          u.approval_status,
          u.approval_reason,
          u.documents_json,
          u.profile_image_url,
          (SELECT json_agg(d.*) FROM user_documents d WHERE d.user_id = u.id) as uploaded_documents,
          -- Farmer stats
          CASE 
            WHEN u.user_type = 'farmer' THEN (
              SELECT COUNT(*)::int FROM fields f WHERE f.owner_id = u.id
            )
            ELSE NULL
          END AS fields_count,
          CASE 
            WHEN u.user_type = 'farmer' THEN (
              SELECT COUNT(*)::int FROM farms fm WHERE fm.owner_id = u.id
            )
            ELSE NULL
          END AS farms_count,
          CASE 
            WHEN u.user_type = 'farmer' THEN (
              SELECT COUNT(*)::int 
              FROM orders o 
              JOIN fields f ON f.id = o.field_id 
              WHERE f.owner_id = u.id
            )
            ELSE NULL
          END AS orders_received,
          CASE 
            WHEN u.user_type = 'farmer' THEN (
              SELECT COALESCE(SUM(o.total_price), 0)::float
              FROM orders o 
              JOIN fields f ON f.id = o.field_id 
              WHERE f.owner_id = u.id
            )
            ELSE NULL
          END AS total_revenue,
          CASE 
            WHEN u.user_type = 'farmer' THEN (
              SELECT COALESCE(AVG(f.rating), 0)::float
              FROM fields f 
              WHERE f.owner_id = u.id
            )
            ELSE NULL
          END AS avg_rating,
          -- Buyer stats
          CASE 
            WHEN u.user_type = 'buyer' THEN (
              SELECT COUNT(*)::int FROM orders o WHERE o.buyer_id = u.id
            )
            ELSE NULL
          END AS orders_placed,
          CASE 
            WHEN u.user_type = 'buyer' THEN (
              SELECT COALESCE(SUM(o.total_price), 0)::float
              FROM orders o 
              WHERE o.buyer_id = u.id
            )
            ELSE NULL
          END AS total_spent
        FROM users u
        WHERE u.id = $1
      `;
    const result = await pool.query(sql, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json('User not found');
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Get a single user by email
router.get('/email/:email', async (req, res) => {
  try {
    const { email } = req.params;
    console.log('Received request for user by email:', email);

    const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    console.log('Query result:', user.rows);

    if (user.rows.length === 0) {
      console.log('User not found for email:', email);
      return res.status(404).json('User not found');
    }

    res.json(user.rows[0]);
  } catch (err) {
    console.error('Error in GET /email/:email:', err);  // Log the full error object
    res.status(500).send('Server Error');
  }
});

// Create a new user
router.post('/', async (req, res) => {
  try {
    const { id, name, email, password, user_type } = req.body;
    console.log('Received request to create user:', { id, name, email, user_type }); // Add logging
    const newUser = await pool.query(
      'INSERT INTO users (id, name, email, password, user_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, name, email, password, user_type]
    );
    console.log('User created successfully:', newUser.rows[0]); // Add logging
    res.json(newUser.rows[0]);
  } catch (err) {
    console.error('Error in POST /users:', err.message); // Add logging
    res.status(500).send('Server Error');
  }
});

// Update a user
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password } = req.body;
    const updateUser = await pool.query(
      'UPDATE users SET name = $1, email = $2, password = $3 WHERE id = $4 RETURNING *',
      [name, email, password, id]
    );
    if (updateUser.rows.length === 0) {
      return res.status(404).json('User not found');
    }
    res.json(updateUser.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Update a user's profile image (user can only update their own)
router.patch('/:id/profile-image', async (req, res) => {
  try {
    const { id } = req.params;
    const { profile_image_url } = req.body;
    if (req.user && req.user.id !== id) {
      return res.status(403).json({ error: 'You can only update your own profile image' });
    }
    const result = await pool.query(
      'UPDATE users SET profile_image_url = $1 WHERE id = $2 RETURNING *',
      [profile_image_url, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json('User not found');
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Delete a user
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleteUser = await pool.query('DELETE FROM users WHERE id = $1 RETURNING *', [id]);
    if (deleteUser.rows.length === 0) {
      return res.status(404).json('User not found');
    }
    res.json('User deleted');
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
