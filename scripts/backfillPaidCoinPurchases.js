/**
 * One-off: credit coin_purchases that Stripe shows as paid but are still pending
 * (webhook never fulfilled them).
 *
 * Usage: node scripts/backfillPaidCoinPurchases.js
 */
require('dotenv').config();
const Stripe = require('stripe');
const pool = require('../db');
const { fulfillCheckoutSession } = require('../src/modules/coins/fulfillCheckoutSession');

async function main() {
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) {
    throw new Error('STRIPE_SECRET_KEY not set');
  }
  const stripe = new Stripe(stripeSecret, { apiVersion: '2023-10-16' });

  const pending = await pool.query(
    `SELECT id, payment_ref, farmer_id, coins_purchased, amount, status, created_at
     FROM coin_purchases
     WHERE status = 'pending' AND payment_ref LIKE 'cs_%'
     ORDER BY created_at DESC
     LIMIT 50`
  );

  console.log(`Found ${pending.rows.length} pending purchases`);
  const summary = { completed: 0, skipped: 0, errors: 0 };

  for (const row of pending.rows) {
    const sessionId = row.payment_ref;
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const result = await fulfillCheckoutSession(session);
      console.log(sessionId, session.payment_status, result);
      if (result.status === 'completed') summary.completed += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(sessionId, err.message);
    }
  }

  console.log('Done:', summary);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
