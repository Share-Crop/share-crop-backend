const express = require('express');
const router = express.Router();
const pool = require('../db');

// Normalize row so amount/balance_after are numbers (DB may return bigint as string)
function normalizeTransactionRow(row) {
    if (!row) return row;
    const out = { ...row };
    if (out.amount != null) out.amount = Number(out.amount) || 0;
    if (out.balance_after != null) out.balance_after = Number(out.balance_after) || 0;
    return out;
}

// Get transactions for a user (filtered by user, admin can see all)
router.get('/', async (req, res) => {
    try {
        const { user_id } = req.query;
        const user = req.user; // From attachUser middleware
        
        // Admin can see all transactions or filter by user_id
        if (user && user.user_type === 'admin') {
            if (user_id) {
                // Admin filtering by specific user
                const transactions = await pool.query(`
                    SELECT 
                        ct.id,
                        ct.user_id,
                        u.name AS user_name,
                        ct.type,
                        ct.amount,
                        ct.reason,
                        ct.balance_after,
                        ct.ref_type,
                        ct.ref_id,
                        ct.created_at
                    FROM coin_transactions ct
                    LEFT JOIN users u ON u.id = ct.user_id
                    WHERE ct.user_id = $1
                    ORDER BY ct.created_at DESC
                    LIMIT 1000
                `, [user_id]);
                return res.json(transactions.rows.map(normalizeTransactionRow));
            } else {
                // Admin sees all transactions
                const transactions = await pool.query(`
                    SELECT 
                        ct.id,
                        ct.user_id,
                        u.name AS user_name,
                        ct.type,
                        ct.amount,
                        ct.reason,
                        ct.balance_after,
                        ct.ref_type,
                        ct.ref_id,
                        ct.created_at
                    FROM coin_transactions ct
                    LEFT JOIN users u ON u.id = ct.user_id
                    ORDER BY ct.created_at DESC
                    LIMIT 1000
                `);
                return res.json(transactions.rows.map(normalizeTransactionRow));
            }
        }
        
        // Regular users see only their own transactions
        if (user && user.id) {
            const transactions = await pool.query(`
                SELECT 
                    ct.id,
                    ct.user_id,
                    ct.type,
                    ct.amount,
                    ct.reason,
                    ct.balance_after,
                    ct.ref_type,
                    ct.ref_id,
                    ct.created_at
                FROM coin_transactions ct
                WHERE ct.user_id = $1
                ORDER BY ct.created_at DESC
                LIMIT 1000
            `, [user.id]);
            return res.json(transactions.rows.map(normalizeTransactionRow));
        }
        
        // No user - require authentication
        if (!user) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        // Fallback: return empty array
        res.json([]);
    } catch (err) {
        console.error('Error getting transactions:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Get transactions for a specific user (admin only or own user)
router.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const user = req.user; // From attachUser middleware
        
        // Check authorization: user can only see their own transactions, admin can see any
        if (user && user.user_type !== 'admin' && user.id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const transactions = await pool.query(`
            SELECT 
                ct.id,
                ct.user_id,
                ct.type,
                ct.amount,
                ct.reason,
                ct.balance_after,
                ct.ref_type,
                ct.ref_id,
                ct.created_at
            FROM coin_transactions ct
            WHERE ct.user_id = $1
            ORDER BY ct.created_at DESC
            LIMIT 1000
        `, [userId]);
        
        res.json(transactions.rows.map(normalizeTransactionRow));
    } catch (err) {
        console.error('Error getting user transactions:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

module.exports = router;

