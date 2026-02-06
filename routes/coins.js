const express = require('express');
const router = express.Router();
const pool = require('../db');

// Coin packs configuration
const COIN_PACKS = [
  { id: 'pack_small', coins: 100, usdCents: 999 },
  { id: 'pack_medium', coins: 500, usdCents: 4499 },
  { id: 'pack_large', coins: 1200, usdCents: 9999 },
  { id: 'pack_xlarge', coins: 2500, usdCents: 19999 },
];

// Get coin packs for purchase (MUST be before /:userId route)
router.get('/packs', async (req, res) => {
    try {
        res.json({
            packs: COIN_PACKS.map((p) => ({
                id: p.id,
                coins: p.coins,
                usdCents: p.usdCents,
                usd: (p.usdCents / 100).toFixed(2),
            })),
        });
    } catch (err) {
        console.error('Error getting coin packs:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Get user's coin balance
router.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        console.log('Received request for user coins:', userId);
        
        const result = await pool.query(
            'SELECT coins FROM users WHERE id = $1',
            [userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({ coins: result.rows[0].coins });
    } catch (err) {
        console.error('Error getting user coins:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Update user's coin balance
router.put('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { coins } = req.body;
        console.log('Received request to update user coins:', userId, 'to', coins);
        
        if (typeof coins !== 'number' || coins < 0) {
            return res.status(400).json({ error: 'Invalid coins value' });
        }
        
        const result = await pool.query(
            'UPDATE users SET coins = $1 WHERE id = $2 RETURNING coins',
            [coins, userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({ coins: result.rows[0].coins });
    } catch (err) {
        console.error('Error updating user coins:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Deduct coins from user's balance
router.post('/:userId/deduct', async (req, res) => {
    try {
        const { userId } = req.params;
        const { amount } = req.body;
        
        if (typeof amount !== 'number' || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount value' });
        }
        
        // Get current balance
        const currentResult = await pool.query(
            'SELECT coins FROM users WHERE id = $1',
            [userId]
        );
        
        if (currentResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const currentCoins = currentResult.rows[0].coins;
        
        if (currentCoins < amount) {
            return res.status(400).json({ error: 'Insufficient coins' });
        }
        
        // Deduct coins
        const newCoins = currentCoins - amount;
        const result = await pool.query(
            'UPDATE users SET coins = $1 WHERE id = $2 RETURNING coins',
            [newCoins, userId]
        );
        
        res.json({ coins: result.rows[0].coins, deducted: amount });
    } catch (err) {
        console.error('Error deducting coins:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Add coins to user's balance
router.post('/:userId/add', async (req, res) => {
    try {
        const { userId } = req.params;
        const { amount } = req.body;
        
        if (typeof amount !== 'number' || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount value' });
        }
        
        // Get current balance
        const currentResult = await pool.query(
            'SELECT coins FROM users WHERE id = $1',
            [userId]
        );
        
        if (currentResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const currentCoins = currentResult.rows[0].coins;
        const newCoins = currentCoins + amount;
        
        const result = await pool.query(
            'UPDATE users SET coins = $1 WHERE id = $2 RETURNING coins',
            [newCoins, userId]
        );
        
        res.json({ coins: result.rows[0].coins, added: amount });
    } catch (err) {
        console.error('Error adding coins:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Create purchase intent (Stripe Checkout)
router.post('/purchase-intent', async (req, res) => {
    try {
        // Check if user is authenticated
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Check if Stripe is configured
        const Stripe = require('stripe');
        const stripeSecret = process.env.STRIPE_SECRET_KEY;
        if (!stripeSecret) {
            return res.status(503).json({ error: 'Payment service not configured' });
        }
        const stripe = new Stripe(stripeSecret, { apiVersion: '2023-10-16' });

        const { pack_id, success_url, cancel_url } = req.body || {};
        const pack = COIN_PACKS.find((p) => p.id === pack_id) || COIN_PACKS[0];
        
        // Default success/cancel URLs
        const finalSuccess = success_url || process.env.SUCCESS_URL || 'http://localhost:3000/farmer/buy-coins?success=1';
        const finalCancel = cancel_url || process.env.CANCEL_URL || 'http://localhost:3000/farmer/buy-coins?cancel=1';

        // Create Stripe Checkout Session
        let session;
        try {
            session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [
                    {
                        price_data: {
                            currency: 'usd',
                            unit_amount: pack.usdCents,
                            product_data: {
                                name: `${pack.coins} ShareCrop Coins`,
                                description: '1 coin = $100 in-app value',
                            },
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                success_url: (finalSuccess.includes('?') ? finalSuccess + '&' : finalSuccess + '?') + 'session_id={CHECKOUT_SESSION_ID}',
                cancel_url: finalCancel,
                client_reference_id: req.user.id,
                metadata: { user_id: req.user.id, pack_id: pack.id, coins: String(pack.coins) },
            });
        } catch (err) {
            console.error('Stripe session create error:', err);
            return res.status(500).json({ error: 'Could not create checkout session' });
        }

        // Insert purchase record (pending status)
        const insertResult = await pool.query(
            `INSERT INTO coin_purchases (user_id, amount_usd_cents, coins_granted, currency, stripe_session_id, status)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [req.user.id, pack.usdCents, pack.coins, 'usd', session.id, 'pending']
        );

        if (insertResult.rows.length === 0) {
            console.error('Failed to insert coin_purchase');
            return res.status(500).json({ error: 'Failed to record purchase' });
        }

        return res.json({ url: session.url, sessionId: session.id });
    } catch (err) {
        console.error('Error creating purchase intent:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

module.exports = router;