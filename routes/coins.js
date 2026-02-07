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
        
        res.json({ coins: Number(result.rows[0].coins) || 0 });
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
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const { userId } = req.params;
        const { amount, reason, refType, refId } = req.body;
        
        console.log('[Coin Deduct] Request:', { userId, amount, reason, refType, refId });
        
        if (typeof amount !== 'number' || amount <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid amount value' });
        }
        
        // Get current balance
        const currentResult = await client.query(
            'SELECT coins FROM users WHERE id = $1',
            [userId]
        );
        
        if (currentResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        
        const currentCoins = Number(currentResult.rows[0].coins) || 0;
        
        if (currentCoins < amount) {
            await client.query('ROLLBACK');
            console.log('[Coin Deduct] Insufficient coins:', { userId, currentCoins, requested: amount });
            return res.status(400).json({ 
                error: 'Insufficient coins',
                currentCoins,
                requested: amount,
                shortfall: amount - currentCoins
            });
        }
        
        // Deduct coins
        const newCoins = currentCoins - amount;
        const updateResult = await client.query(
            'UPDATE users SET coins = $1 WHERE id = $2 RETURNING coins',
            [newCoins, userId]
        );
        
        // Create transaction record
        try {
            await client.query(
                `INSERT INTO coin_transactions (user_id, type, amount, balance_after, reason, ref_type, ref_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    userId,
                    'debit',
                    amount,
                    newCoins,
                    reason || 'Field purchase',
                    refType || 'order',
                    refId || null
                ]
            );
            console.log('[Coin Deduct] Transaction recorded:', { userId, amount, newCoins });
        } catch (txError) {
            // Log error but don't fail the deduction if transaction table has issues
            console.error('[Coin Deduct] Failed to create transaction record:', txError.message);
        }
        
        await client.query('COMMIT');
        
        console.log('[Coin Deduct] Success:', { userId, deducted: amount, balanceBefore: currentCoins, balanceAfter: newCoins });
        
        res.json({ 
            coins: updateResult.rows[0].coins, 
            deducted: amount,
            balanceBefore: currentCoins,
            balanceAfter: newCoins
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Coin Deduct] Error:', err.message);
        console.error('[Coin Deduct] Stack:', err.stack);
        res.status(500).json({ error: 'Server Error', message: err.message });
    } finally {
        client.release();
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
        
        const currentCoins = Number(currentResult.rows[0].coins) || 0;
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
        // Use existing schema: farmer_id, amount, coins_purchased, payment_ref (to avoid breaking existing code)
        console.log('[Purchase Intent] Creating purchase record:', {
            userId: req.user.id,
            packId: pack.id,
            coins: pack.coins,
            amount: pack.usdCents / 100,
            sessionId: session.id
        });
        
        const insertResult = await pool.query(
            `INSERT INTO coin_purchases (farmer_id, amount, coins_purchased, currency, payment_ref, status)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [req.user.id, pack.usdCents / 100, pack.coins, 'usd', session.id, 'pending']
        );

        if (insertResult.rows.length === 0) {
            console.error('[Purchase Intent] Failed to insert coin_purchase');
            return res.status(500).json({ error: 'Failed to record purchase' });
        }

        console.log('[Purchase Intent] Purchase recorded successfully. ID:', insertResult.rows[0].id);
        console.log('[Purchase Intent] Redirecting to Stripe Checkout:', session.url);
        
        return res.json({ url: session.url, sessionId: session.id });
    } catch (err) {
        console.error('Error creating purchase intent:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

module.exports = router;