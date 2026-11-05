const pool = require('../../../db');

/**
 * Credit coins for a paid Stripe Checkout session (idempotent).
 * Used by webhooks and by POST /api/coins/confirm-session after redirect.
 *
 * @param {object} session - Stripe Checkout Session object (must include id, payment_status, amount_total, currency, client_reference_id/metadata)
 * @returns {Promise<{ status: string, coinsAdded?: number, balanceAfter?: number, purchaseId?: string, reason?: string }>}
 */
async function fulfillCheckoutSession(session) {
  const sessionId = session?.id;
  if (!sessionId) {
    return { status: 'skipped', reason: 'missing_session_id' };
  }

  if (session.payment_status !== 'paid') {
    return { status: 'skipped', reason: 'not_paid' };
  }

  const existingResult = await pool.query(
    `SELECT id, status, farmer_id as user_id, coins_purchased as coins_granted,
            amount, app_fee_amount, currency
     FROM coin_purchases WHERE payment_ref = $1`,
    [sessionId]
  );

  if (existingResult.rows.length === 0) {
    return { status: 'skipped', reason: 'purchase_not_found' };
  }

  const existing = existingResult.rows[0];

  if (existing.status === 'completed') {
    return {
      status: 'already_processed',
      purchaseId: existing.id,
      coinsAdded: Number(existing.coins_granted) || 0,
    };
  }

  const refUser = session.client_reference_id || session.metadata?.user_id;
  if (!refUser || String(refUser) !== String(existing.user_id)) {
    return { status: 'skipped', reason: 'user_mismatch' };
  }

  const subtotalCents = Math.round(Number(existing.amount) * 100);
  const feeCents = Math.round(Number(existing.app_fee_amount || 0) * 100);
  const expectedTotalCents = subtotalCents + feeCents;
  const paidCents = session.amount_total;
  const sessionCurrency = (session.currency || '').toLowerCase();
  const purchaseCurrency = (existing.currency || '').toLowerCase();

  if (typeof paidCents !== 'number' || Math.abs(paidCents - expectedTotalCents) > 1) {
    console.error('[FulfillCheckout] amount_total mismatch', {
      sessionId,
      paidCents,
      expectedTotalCents,
    });
    return { status: 'skipped', reason: 'amount_mismatch' };
  }
  if (sessionCurrency && purchaseCurrency && sessionCurrency !== purchaseCurrency) {
    console.error('[FulfillCheckout] currency mismatch', {
      sessionId,
      sessionCurrency,
      purchaseCurrency,
    });
    return { status: 'skipped', reason: 'currency_mismatch' };
  }

  const userId = existing.user_id;
  const coinsToAdd = Number(existing.coins_granted) || 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const purchaseLock = await client.query(
      'SELECT id, status FROM coin_purchases WHERE id = $1 FOR UPDATE',
      [existing.id]
    );

    if (purchaseLock.rows.length === 0 || purchaseLock.rows[0].status === 'completed') {
      await client.query('ROLLBACK');
      return {
        status: 'already_processed',
        purchaseId: existing.id,
        coinsAdded: coinsToAdd,
      };
    }

    const userResult = await client.query(
      'SELECT coins FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );

    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { status: 'error', reason: 'user_not_found' };
    }

    const balanceBefore = Number(userResult.rows[0].coins) || 0;
    const balanceAfter = balanceBefore + coinsToAdd;

    console.log('[FulfillCheckout] Crediting coins:', {
      sessionId,
      userId,
      coinsToAdd,
      balanceBefore,
      balanceAfter,
    });

    await client.query('UPDATE users SET coins = $1 WHERE id = $2', [balanceAfter, userId]);

    await client.query(
      `INSERT INTO coin_transactions (user_id, type, amount, balance_after, reason, ref_type, ref_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        'credit',
        coinsToAdd,
        balanceAfter,
        'Coin purchase',
        'coin_purchase',
        existing.id,
        'completed',
      ]
    );

    try {
      await client.query(
        'UPDATE coin_purchases SET status = $1, completed_at = NOW() WHERE id = $2',
        ['completed', existing.id]
      );
    } catch (err) {
      if (err.message && err.message.includes('completed_at')) {
        await client.query('UPDATE coin_purchases SET status = $1 WHERE id = $2', [
          'completed',
          existing.id,
        ]);
      } else {
        throw err;
      }
    }

    await client.query('COMMIT');
    return {
      status: 'completed',
      purchaseId: existing.id,
      coinsAdded: coinsToAdd,
      balanceAfter,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { fulfillCheckoutSession };
