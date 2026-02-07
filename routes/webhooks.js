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
        // Ensure numeric: DB may return coins_granted/coins_purchased as string (e.g. bigint), which would cause 90 + "100" => "90100"
        const coinsToAdd = Number(existing.coins_granted) || 0;

        // Get current user balance
        const userResult = await pool.query(
            'SELECT coins FROM users WHERE id = $1',
            [userId]
        );

        if (userResult.rows.length === 0) {
            console.error('User not found:', userId);
            return res.status(500).send('User not found');
        }

        const balanceBefore = Number(userResult.rows[0].coins) || 0;
        const balanceAfter = balanceBefore + coinsToAdd;
        
        console.log('[Webhook] Crediting coins:', { userId, coinsToAdd, balanceBefore, balanceAfter });

        // Update user coins
        await pool.query(
            'UPDATE users SET coins = $1 WHERE id = $2',
            [balanceAfter, userId]
        );
        
        console.log('[Webhook] User coins updated successfully');

        // Insert coin_transaction (audit trail)
        await pool.query(
            `INSERT INTO coin_transactions (user_id, type, amount, balance_after, reason, ref_type, ref_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, 'credit', coinsToAdd, balanceAfter, 'Coin purchase', 'coin_purchase', existing.id]
        );

        // Mark purchase as completed (completed_at may not exist in schema)
        try {
            await pool.query(
                'UPDATE coin_purchases SET status = $1, completed_at = NOW() WHERE id = $2',
                ['completed', existing.id]
            );
        } catch (err) {
            // If completed_at doesn't exist, just update status
            if (err.message && err.message.includes('completed_at')) {
                await pool.query(
                    'UPDATE coin_purchases SET status = $1 WHERE id = $2',
                    ['completed', existing.id]
                );
            } else {
                throw err;
            }
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
