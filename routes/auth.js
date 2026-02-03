const express = require('express');
const router = express.Router();
const pool = require('../db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

// Helper function to generate JWT token
function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      user_type: user.user_type,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// Helper function to validate email format
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Helper function to validate password strength
function isValidPassword(password) {
  // At least 6 characters (simple validation)
  return password && password.length >= 6;
}

/**
 * POST /api/auth/signup
 * Register a new user
 * 
 * Body:
 * - name: string (required)
 * - email: string (required, must be unique)
 * - password: string (required, min 6 characters)
 * - user_type: string (required, 'farmer' or 'buyer')
 */
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, user_type, profile_image_url, documents } = req.body;

    // Validation
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Name is required' });
    }

    if (!email || email.trim().length === 0) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    if (!user_type) {
      return res.status(400).json({ error: 'User type is required' });
    }

    const normalizedUserType = user_type.toLowerCase();
    if (!['farmer', 'buyer', 'admin'].includes(normalizedUserType)) {
      return res.status(400).json({ error: 'User type must be farmer, buyer, or admin' });
    }

    // Check if email already exists
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create user (using PostgreSQL's gen_random_uuid())
    const result = await pool.query(
      `INSERT INTO users (id, name, email, password, user_type, email_verified, is_active, created_at, profile_image_url)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), $7)
       RETURNING id, name, email, user_type, created_at, email_verified, is_active, profile_image_url`,
      [
        name.trim(),
        email.toLowerCase().trim(),
        hashedPassword,
        normalizedUserType,
        false, // email_verified (skip for now)
        true,  // is_active
        profile_image_url || null
      ]
    );

    const newUser = result.rows[0];

    // Handle documents if provided (only for farmers usually, but API can be flexible)
    if (documents && Array.isArray(documents) && documents.length > 0) {
      for (const doc of documents) {
        if (doc.file_name && doc.file_url) {
          await pool.query(
            'INSERT INTO user_documents (user_id, file_name, file_url, file_type) VALUES ($1, $2, $3, $4)',
            [newUser.id, doc.file_name, doc.file_url, doc.file_type || 'other']
          );
        }
      }
    }

    // Generate JWT token
    const token = generateToken(newUser);

    // Update last_login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [newUser.id]);

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        user_type: newUser.user_type,
        email_verified: newUser.email_verified,
        is_active: newUser.is_active,
        profile_image_url: newUser.profile_image_url,
      },
      token,
    });
  } catch (err) {
    console.error('Signup error:', err.message);

    // Handle unique constraint violation
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }

    res.status(500).json({ error: 'Server Error', details: err.message });
  }
});

/**
 * POST /api/auth/login
 * Login user and get JWT token
 * 
 * Body:
 * - email: string (required)
 * - password: string (required)
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || email.trim().length === 0) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    // Find user by email
    const userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = userResult.rows[0];

    // Check if account is locked
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({
        error: 'Account is locked due to too many failed login attempts',
        locked_until: user.locked_until,
      });
    }

    // Check if account is active
    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    // Check password (handle both hashed and plain text for migration)
    let passwordValid = false;

    // Try bcrypt comparison first (for new hashed passwords)
    if (user.password.startsWith('$2')) {
      passwordValid = await bcrypt.compare(password, user.password);
    } else {
      // Fallback for old plain text passwords (during migration)
      passwordValid = user.password === password;

      // If login successful with plain text, hash it for next time
      if (passwordValid) {
        const hashedPassword = await bcrypt.hash(password, 12);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, user.id]);
      }
    }

    if (!passwordValid) {
      // Increment login attempts
      const newAttempts = (user.login_attempts || 0) + 1;
      const maxAttempts = 5;

      if (newAttempts >= maxAttempts) {
        // Lock account for 15 minutes
        const lockUntil = new Date(Date.now() + 15 * 60 * 1000);
        await pool.query(
          'UPDATE users SET login_attempts = $1, locked_until = $2 WHERE id = $3',
          [newAttempts, lockUntil, user.id]
        );
        return res.status(423).json({
          error: 'Too many failed login attempts. Account locked for 15 minutes.',
          locked_until: lockUntil,
        });
      } else {
        await pool.query('UPDATE users SET login_attempts = $1 WHERE id = $2', [newAttempts, user.id]);
      }

      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Reset login attempts on successful login
    await pool.query(
      'UPDATE users SET login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1',
      [user.id]
    );

    // Generate JWT token
    const token = generateToken(user);

    // Return user data (exclude password)
    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        user_type: user.user_type,
        email_verified: user.email_verified || false,
        is_active: user.is_active,
        coins: user.coins || 0,
        profile_image_url: user.profile_image_url,
      },
      token,
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server Error', details: err.message });
  }
});

/**
 * GET /api/auth/me
 * Get current user from JWT token
 * Requires: Authorization header with Bearer token
 */
router.get('/me', async (req, res) => {
  try {
    // Get user from attachUser middleware
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Fetch fresh user data from database
    const userResult = await pool.query(
      'SELECT id, name, email, user_type, email_verified, is_active, approval_status, coins, created_at, last_login, profile_image_url, (SELECT json_agg(d.*) FROM user_documents d WHERE d.user_id = id) as uploaded_documents FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        user_type: user.user_type,
        email_verified: user.email_verified || false,
        is_active: user.is_active,
        approval_status: user.approval_status, // Added this field
        coins: user.coins || 0,
        created_at: user.created_at,
        last_login: user.last_login,
        profile_image_url: user.profile_image_url,
        uploaded_documents: user.uploaded_documents || [],
      },
    });
  } catch (err) {
    console.error('Get me error:', err.message);
    res.status(500).json({ error: 'Server Error', details: err.message });
  }
});

/**
 * PUT /api/auth/profile
 * Update user profile (name, email)
 * Requires: Authorization header with Bearer token
 * Body:
 * - name: string (optional)
 * - email: string (optional, must be unique if provided)
 */
router.put('/profile', async (req, res) => {
  try {
    // Get user from attachUser middleware
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { name, email } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    // Validate and prepare updates
    if (name !== undefined) {
      if (!name || name.trim().length === 0) {
        return res.status(400).json({ error: 'Name cannot be empty' });
      }
      updates.push(`name = $${paramCount}`);
      values.push(name.trim());
      paramCount++;
    }

    if (email !== undefined) {
      if (!email || email.trim().length === 0) {
        return res.status(400).json({ error: 'Email cannot be empty' });
      }
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      // Check if email is already taken by another user
      const emailCheck = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email.toLowerCase().trim(), req.user.id]
      );
      if (emailCheck.rows.length > 0) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      updates.push(`email = $${paramCount}`);
      values.push(email.toLowerCase().trim());
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // Add updated_at
    updates.push(`updated_at = NOW()`);
    values.push(req.user.id);

    // Update user
    const updateQuery = `
      UPDATE users 
      SET ${updates.join(', ')} 
      WHERE id = $${paramCount}
      RETURNING id, name, email, user_type, email_verified, is_active, coins, created_at, updated_at, profile_image_url
    `;

    const result = await pool.query(updateQuery, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updatedUser = result.rows[0];

    res.json({
      message: 'Profile updated successfully',
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        user_type: updatedUser.user_type,
        email_verified: updatedUser.email_verified || false,
        is_active: updatedUser.is_active,
        coins: updatedUser.coins || 0,
        created_at: updatedUser.created_at,
        updated_at: updatedUser.updated_at,
        profile_image_url: updatedUser.profile_image_url,
      },
    });
  } catch (err) {
    console.error('Update profile error:', err.message);
    res.status(500).json({ error: 'Server Error', details: err.message });
  }
});

/**
 * PUT /api/auth/password
 * Change user password
 * Requires: Authorization header with Bearer token
 * Body:
 * - currentPassword: string (required)
 * - newPassword: string (required, min 6 characters)
 */
router.put('/password', async (req, res) => {
  try {
    // Get user from attachUser middleware
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { currentPassword, newPassword } = req.body;

    // Validation
    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password is required' });
    }

    if (!newPassword) {
      return res.status(400).json({ error: 'New password is required' });
    }

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from current password' });
    }

    // Get user with password
    const userResult = await pool.query('SELECT id, password FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Verify current password
    let passwordMatch = false;
    if (user.password && user.password.startsWith('$2')) {
      // Hashed password (bcrypt)
      passwordMatch = await bcrypt.compare(currentPassword, user.password);
    } else {
      // Plaintext password (legacy - should be migrated)
      passwordMatch = user.password === currentPassword;
    }

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await pool.query(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2',
      [hashedPassword, req.user.id]
    );

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ error: 'Server Error', details: err.message });
  }
});

module.exports = router;
