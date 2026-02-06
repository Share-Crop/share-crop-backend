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

        // Idempotent: check if we already processed this session
        const existingResult = await pool.query(
            'SELECT id, status, user_id, coins_granted FROM coin_purchases WHERE stripe_session_id = $1',
            [sessionId]
        );

        if (existingResult.rows.length === 0) {
            console.error('coin_purchase not found for session:', sessionId);
            return res.status(400).send('Purchase record not found');
        }

        const existing = existingResult.rows[0];

        if (existing.status === 'completed') {
            return res.json({ received: true, already_processed: true });
        }

        const userId = existing.user_id;
        const coinsToAdd = existing.coins_granted;

        // Get current user balance
        const userResult = await pool.query(
            'SELECT coins FROM users WHERE id = $1',
            [userId]
        );

        if (userResult.rows.length === 0) {
            console.error('User not found:', userId);
            return res.status(500).send('User not found');
        }

        const balanceAfter = (Number(userResult.rows[0].coins) || 0) + coinsToAdd;

        // Update user coins
        await pool.query(
            'UPDATE users SET coins = $1 WHERE id = $2',
            [balanceAfter, userId]
        );

        // Insert coin_transaction (audit trail)
        await pool.query(
            `INSERT INTO coin_transactions (user_id, type, amount, balance_after, reason, ref_type, ref_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, 'credit', coinsToAdd, balanceAfter, 'Coin purchase', 'coin_purchase', existing.id]
        );

        // Mark purchase as completed
        await pool.query(
            'UPDATE coin_purchases SET status = $1, completed_at = NOW() WHERE id = $2',
            ['completed', existing.id]
        );

        res.json({ received: true });
    } catch (err) {
        console.error('Webhook error:', err.message);
        res.status(500).send('Webhook processing failed');
    }
});

module.exports = router;
