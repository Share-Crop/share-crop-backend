const express = require('express');
const router = express.Router();
const pool = require('../db');

// Stripe webhook handler (receives raw body - must be handled before JSON parsing)
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const Stripe = require('stripe');
        const stripeSecret = process.env.STRIPE_SECRET_KEY;
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

        if (!stripeSecret || !webhookSecret) {
            return res.status(500).send('Webhook not configured');
        }

        const stripe = new Stripe(stripeSecret, { apiVersion: '2023-10-16' });
        const sig = req.headers['stripe-signature'];

        let event;
        try {
            event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        } catch (err) {
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        // Only process checkout.session.completed events
        if (event.type !== 'checkout.session.completed') {
            return res.json({ received: true });
        }

        const session = event.data.object;
        const sessionId = session.id;
        
        console.log('[Webhook] Processing checkout.session.completed for session:', sessionId);

        // Idempotent: check if we already processed this session
        // Use existing schema: payment_ref (to match what purchase-intent creates)
        const existingResult = await pool.query(
            'SELECT id, status, farmer_id as user_id, coins_purchased as coins_granted FROM coin_purchases WHERE payment_ref = $1',
            [sessionId]
        );
        
        console.log('[Webhook] Found purchase record:', existingResult.rows.length > 0 ? JSON.stringify(existingResult.rows[0], null, 2) : 'none');

        if (existingResult.rows.length === 0) {
            console.error('[Webhook] coin_purchase not found for session:', sessionId);
            // Log all recent purchases for debugging
            const recentPurchases = await pool.query(
                'SELECT id, farmer_id, payment_ref, status, created_at FROM coin_purchases ORDER BY created_at DESC LIMIT 5'
            );
            console.error('[Webhook] Recent purchases:', JSON.stringify(recentPurchases.rows, null, 2));
            return res.status(400).send('Purchase record not found');
        }

        const existing = existingResult.rows[0];

        if (existing.status === 'completed') {
            return res.json({ received: true, already_processed: true });
        }

        const userId = existing.user_id;
        const coinsToAdd = Number(existing.coins_granted) || 0;

        // Use transaction with FOR UPDATE for atomicity
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Lock purchase row (already checked, but lock for consistency)
            const purchaseLock = await client.query(
                'SELECT id, status FROM coin_purchases WHERE id = $1 FOR UPDATE',
                [existing.id]
            );

            if (purchaseLock.rows.length === 0 || purchaseLock.rows[0].status === 'completed') {
                await client.query('ROLLBACK');
                return res.json({ received: true, already_processed: true });
            }

            // Lock user row and get current balance
            const userResult = await client.query(
                'SELECT coins FROM users WHERE id = $1 FOR UPDATE',
                [userId]
            );

            if (userResult.rows.length === 0) {
                await client.query('ROLLBACK');
                console.error('User not found:', userId);
                return res.status(500).send('User not found');
            }

            const balanceBefore = Number(userResult.rows[0].coins) || 0;
            const balanceAfter = balanceBefore + coinsToAdd;
            
            console.log('[Webhook] Crediting coins:', { userId, coinsToAdd, balanceBefore, balanceAfter });

            // Update user coins
            await client.query(
                'UPDATE users SET coins = $1 WHERE id = $2',
                [balanceAfter, userId]
            );

            // Insert coin_transaction (audit trail)
            await client.query(
                `INSERT INTO coin_transactions (user_id, type, amount, balance_after, reason, ref_type, ref_id, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [userId, 'credit', coinsToAdd, balanceAfter, 'Coin purchase', 'coin_purchase', existing.id, 'completed']
            );

            // Mark purchase as completed
            try {
                await client.query(
                    'UPDATE coin_purchases SET status = $1, completed_at = NOW() WHERE id = $2',
                    ['completed', existing.id]
                );
            } catch (err) {
                // If completed_at doesn't exist, just update status
                if (err.message && err.message.includes('completed_at')) {
                    await client.query(
                        'UPDATE coin_purchases SET status = $1 WHERE id = $2',
                        ['completed', existing.id]
                    );
                } else {
                    throw err;
                }
            }

            await client.query('COMMIT');
            console.log('[Webhook] Successfully processed payment for session:', sessionId);
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        console.log('[Webhook] Successfully processed payment for session:', sessionId);
        res.json({ received: true });
    } catch (err) {
        console.error('[Webhook] Error:', err.message);
        console.error('[Webhook] Stack:', err.stack);
        res.status(500).send('Webhook processing failed');
    }
});

module.exports = router;
