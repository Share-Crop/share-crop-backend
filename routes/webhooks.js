const express = require('express');
const router = express.Router();
const { fulfillCheckoutSession } = require('../src/modules/coins/fulfillCheckoutSession');

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

        const result = await fulfillCheckoutSession(session);

        if (result.status === 'error') {
            console.error('[Webhook] Fulfillment error:', result.reason, sessionId);
            return res.status(500).send('Webhook processing failed');
        }

        if (result.status === 'skipped') {
            console.warn('[Webhook] Skipped session:', sessionId, result.reason);
        } else if (result.status === 'completed') {
            console.log('[Webhook] Successfully processed payment for session:', sessionId);
        }

        res.json({ received: true, ...result });
    } catch (err) {
        console.error('[Webhook] Error:', err.message);
        console.error('[Webhook] Stack:', err.stack);
        res.status(500).send('Webhook processing failed');
    }
});

module.exports = router;
