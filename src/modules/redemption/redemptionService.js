const pool = require('../../../db');

// Configuration from environment variables
const REDEMPTION_COINS_PER_USD = parseFloat(process.env.REDEMPTION_COINS_PER_USD || '100');
const REDEMPTION_PLATFORM_FEE_PERCENT = parseFloat(process.env.REDEMPTION_PLATFORM_FEE_PERCENT || '20');
const REDEMPTION_MIN_COINS = parseInt(process.env.REDEMPTION_MIN_COINS || '1000');
const REDEMPTION_MAX_COINS = parseInt(process.env.REDEMPTION_MAX_COINS || '1000000');
const REDEMPTION_MAX_FIAT_CENTS_PER_DAY = parseInt(process.env.REDEMPTION_MAX_FIAT_CENTS_PER_DAY || '50000');
const REDEMPTION_MIN_AGE_DAYS = parseInt(process.env.REDEMPTION_MIN_AGE_DAYS || '7');

/**
 * Create a redemption request
 * Locks coins and creates redemption record
 */
async function createRedemptionRequest(userId, coinsRequested, payoutMethodId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate input
    if (!Number.isInteger(coinsRequested) || coinsRequested < REDEMPTION_MIN_COINS || coinsRequested > REDEMPTION_MAX_COINS) {
      await client.query('ROLLBACK');
      throw new Error(`Coins must be between ${REDEMPTION_MIN_COINS} and ${REDEMPTION_MAX_COINS}`);
    }

    // Check for existing pending redemption
    const existingPending = await client.query(
      `SELECT id FROM redemption_requests 
       WHERE user_id = $1 AND status IN ('pending', 'under_review') 
       LIMIT 1`,
      [userId]
    );
    if (existingPending.rows.length > 0) {
      await client.query('ROLLBACK');
      throw new Error('You already have a pending redemption request');
    }

    // Validate payout method ownership if provided
    if (payoutMethodId) {
      const payoutMethod = await client.query(
        'SELECT id, user_id FROM user_payout_methods WHERE id = $1',
        [payoutMethodId]
      );
      if (payoutMethod.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('Payout method not found');
      }
      if (payoutMethod.rows[0].user_id !== userId) {
        await client.query('ROLLBACK');
        throw new Error('Payout method does not belong to you');
      }
    }

    // Lock user row and get current balance
    const userResult = await client.query(
      'SELECT coins, locked_coins FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('User not found');
    }

    const currentCoins = Number(userResult.rows[0].coins) || 0;
    const currentLocked = Number(userResult.rows[0].locked_coins) || 0;

    // Validate sufficient balance
    if (currentCoins < coinsRequested) {
      await client.query('ROLLBACK');
      throw new Error(`Insufficient coins. Available: ${currentCoins}, Requested: ${coinsRequested}`);
    }

    // Calculate conversion and fees
    const conversionRate = 1 / REDEMPTION_COINS_PER_USD; // e.g., 0.01 for 100 coins = $1
    const fiatAmountCents = Math.floor((coinsRequested * conversionRate) * 100);
    const platformFeeCents = Math.floor(fiatAmountCents * (REDEMPTION_PLATFORM_FEE_PERCENT / 100));
    const payoutAmountCents = fiatAmountCents - platformFeeCents;

    // Lock coins: move from available to locked
    const newCoins = currentCoins - coinsRequested;
    const newLocked = currentLocked + coinsRequested;

    await client.query(
      'UPDATE users SET coins = $1, locked_coins = $2 WHERE id = $3',
      [newCoins, newLocked, userId]
    );

    // Create redemption request
    const redemptionResult = await client.query(
      `INSERT INTO redemption_requests 
       (user_id, coins_requested, conversion_rate, currency, fiat_amount_cents, 
        platform_fee_cents, payout_amount_cents, payout_method_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, status, payout_amount_cents, created_at`,
      [userId, coinsRequested, conversionRate, 'USD', fiatAmountCents, 
       platformFeeCents, payoutAmountCents, payoutMethodId || null, 'pending']
    );

    const redemptionId = redemptionResult.rows[0].id;

    // Create ledger entry
    await client.query(
      `INSERT INTO coin_transactions 
       (user_id, type, amount, balance_after, reason, ref_type, ref_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, 'redeem_request', coinsRequested, newCoins, 'Redemption request', 
       'redemption_request', redemptionId, 'completed']
    );

    await client.query('COMMIT');

    return {
      id: redemptionId,
      status: redemptionResult.rows[0].status,
      payout_amount_cents: redemptionResult.rows[0].payout_amount_cents,
      created_at: redemptionResult.rows[0].created_at
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reject a redemption request
 * Unlocks coins and marks as rejected
 */
async function rejectRedemption(redemptionId, adminId, adminNotes) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock redemption and user rows
    const redemptionResult = await client.query(
      `SELECT id, user_id, coins_requested, status 
       FROM redemption_requests 
       WHERE id = $1 FOR UPDATE`,
      [redemptionId]
    );

    if (redemptionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Redemption request not found');
    }

    const redemption = redemptionResult.rows[0];
    if (!['pending', 'under_review'].includes(redemption.status)) {
      await client.query('ROLLBACK');
      throw new Error(`Cannot reject redemption with status: ${redemption.status}`);
    }

    // Lock user row
    await client.query(
      'SELECT coins, locked_coins FROM users WHERE id = $1 FOR UPDATE',
      [redemption.user_id]
    );

    // Unlock coins: move from locked back to available
    await client.query(
      `UPDATE users 
       SET coins = coins + $1, locked_coins = locked_coins - $1 
       WHERE id = $2`,
      [redemption.coins_requested, redemption.user_id]
    );

    // Update redemption status
    await client.query(
      `UPDATE redemption_requests 
       SET status = 'rejected', reviewed_at = now(), reviewed_by = $1, admin_notes = $2
       WHERE id = $3`,
      [adminId, adminNotes || null, redemptionId]
    );

    // Get updated balance for ledger
    const userResult = await client.query(
      'SELECT coins FROM users WHERE id = $1',
      [redemption.user_id]
    );
    const newBalance = Number(userResult.rows[0].coins) || 0;

    // Create ledger entry
    await client.query(
      `INSERT INTO coin_transactions 
       (user_id, type, amount, balance_after, reason, ref_type, ref_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [redemption.user_id, 'redeem_rejected', redemption.coins_requested, newBalance,
       'Redemption rejected', 'redemption_request', redemptionId, 'completed']
    );

    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Approve and execute payout for a redemption request
 * Creates Stripe transfer and marks as paid
 */
async function approveRedemption(redemptionId, adminId, adminNotes) {
  const client = await pool.connect();
  let stripeTransferId = null;
  let clientReleased = false;

  try {
    await client.query('BEGIN');

    // Lock redemption row first (FOR UPDATE OF r specifies which table to lock)
    const redemptionResult = await client.query(
      `SELECT r.id, r.user_id, r.coins_requested, r.payout_amount_cents, 
              r.payout_method_id, r.status, r.stripe_transfer_id,
              u.stripe_connect_account_id, pm.stripe_account_id, pm.stripe_external_account_id
       FROM redemption_requests r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN user_payout_methods pm ON pm.id = r.payout_method_id
       WHERE r.id = $1 FOR UPDATE OF r`,
      [redemptionId]
    );

    if (redemptionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      clientReleased = true;
      throw new Error('Redemption request not found');
    }

    const redemption = redemptionResult.rows[0];

    if (redemption.status === 'paid') {
      await client.query('ROLLBACK');
      client.release();
      clientReleased = true;
      return { success: true, message: 'Already paid', stripe_transfer_id: redemption.stripe_transfer_id };
    }

    if (!['pending', 'under_review', 'approved'].includes(redemption.status)) {
      await client.query('ROLLBACK');
      client.release();
      clientReleased = true;
      throw new Error(`Cannot approve redemption with status: ${redemption.status}`);
    }

    // Update status to approved first
    await client.query(
      `UPDATE redemption_requests 
       SET status = 'approved', reviewed_at = now(), reviewed_by = $1, admin_notes = $2
       WHERE id = $3`,
      [adminId, adminNotes || null, redemptionId]
    );

    await client.query('COMMIT');
    client.release();
    clientReleased = true;

    // Create Stripe transfer (outside transaction to avoid long locks)
    if (redemption.stripe_connect_account_id) {
      try {
        const Stripe = require('stripe');
        const stripeSecret = process.env.STRIPE_SECRET_KEY;
        if (!stripeSecret) {
          throw new Error('Stripe not configured');
        }
        const stripe = new Stripe(stripeSecret, { apiVersion: '2023-10-16' });

        console.log('[Approve Redemption] Creating Stripe transfer:', {
          redemptionId,
          userId: redemption.user_id,
          amount: redemption.payout_amount_cents,
          destination: redemption.stripe_connect_account_id
        });

        // Create transfer to connected account
        const transfer = await stripe.transfers.create({
          amount: redemption.payout_amount_cents,
          currency: 'usd',
          destination: redemption.stripe_connect_account_id,
        });

        console.log('[Approve Redemption] Stripe transfer created successfully:', {
          transferId: transfer.id,
          amount: transfer.amount,
          destination: transfer.destination,
          status: transfer.status
        });

        stripeTransferId = transfer.id;

        // Update redemption with transfer id and mark as paid
        const updateClient = await pool.connect();
        try {
          await updateClient.query('BEGIN');

          // Lock again for update
          await updateClient.query(
            'SELECT id FROM redemption_requests WHERE id = $1 FOR UPDATE',
            [redemptionId]
          );

          await updateClient.query(
            `UPDATE redemption_requests 
             SET status = 'paid', stripe_transfer_id = $1, stripe_account_id = $2
             WHERE id = $3`,
            [stripeTransferId, redemption.stripe_connect_account_id, redemptionId]
          );

          // Lock user and deduct locked coins
          await updateClient.query(
            'SELECT locked_coins FROM users WHERE id = $1 FOR UPDATE',
            [redemption.user_id]
          );

          await updateClient.query(
            'UPDATE users SET locked_coins = locked_coins - $1 WHERE id = $2',
            [redemption.coins_requested, redemption.user_id]
          );

          // Create ledger entry
          const userResult = await updateClient.query(
            'SELECT coins, locked_coins FROM users WHERE id = $1',
            [redemption.user_id]
          );
          const newLocked = Number(userResult.rows[0].locked_coins) || 0;

          await updateClient.query(
            `INSERT INTO coin_transactions 
             (user_id, type, amount, balance_after, reason, ref_type, ref_id, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [redemption.user_id, 'redeem_approved', redemption.coins_requested, 
             newLocked, 'Redemption paid', 'redemption_request', redemptionId, 'completed']
          );

          await updateClient.query('COMMIT');
        } catch (err) {
          await updateClient.query('ROLLBACK');
          throw err;
        } finally {
          updateClient.release();
        }
      } catch (stripeErr) {
        console.error('[Approve Redemption] Stripe error:', stripeErr);
        console.error('[Approve Redemption] Stripe error details:', {
          type: stripeErr.type,
          code: stripeErr.code,
          message: stripeErr.message,
          statusCode: stripeErr.statusCode
        });
        
        // Mark as failed and unlock coins so user can try again
        const failClient = await pool.connect();
        let statusUpdated = false;
        try {
          await failClient.query('BEGIN');

          // Lock redemption and user rows
          await failClient.query(
            'SELECT id FROM redemption_requests WHERE id = $1 FOR UPDATE',
            [redemptionId]
          );
          await failClient.query(
            'SELECT locked_coins FROM users WHERE id = $1 FOR UPDATE',
            [redemption.user_id]
          );

          // Unlock coins (return to available)
          await failClient.query(
            `UPDATE users 
             SET coins = coins + $1, locked_coins = locked_coins - $1 
             WHERE id = $2`,
            [redemption.coins_requested, redemption.user_id]
          );

          // Update status to failed (CRITICAL - must happen)
          const updateResult = await failClient.query(
            `UPDATE redemption_requests 
             SET status = 'failed', admin_notes = COALESCE(admin_notes || E'\\n', '') || $1
             WHERE id = $2
             RETURNING id, status`,
            [`Stripe error: ${stripeErr.message}`, redemptionId]
          );
          
          statusUpdated = updateResult.rows.length > 0;
          console.log('[Approve Redemption] Status updated to failed:', statusUpdated, updateResult.rows[0]);

          // Get updated balance for ledger
          const userResult = await failClient.query(
            'SELECT coins FROM users WHERE id = $1',
            [redemption.user_id]
          );
          const newBalance = Number(userResult.rows[0].coins) || 0;

          // Create ledger entry
          await failClient.query(
            `INSERT INTO coin_transactions 
             (user_id, type, amount, balance_after, reason, ref_type, ref_id, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [redemption.user_id, 'redeem_rejected', redemption.coins_requested, newBalance,
             'Redemption failed - Stripe transfer error', 'redemption_request', redemptionId, 'completed']
          );

          await failClient.query('COMMIT');
          console.log('[Approve Redemption] Failed redemption processed successfully - coins unlocked, status set to failed');
        } catch (err) {
          await failClient.query('ROLLBACK');
          console.error('[Approve Redemption] CRITICAL: Error handling Stripe failure:', err);
          console.error('[Approve Redemption] Status update failed:', statusUpdated);
          // Try one more time without transaction to ensure status is updated
          try {
            await pool.query(
              `UPDATE redemption_requests SET status = 'failed' WHERE id = $1`,
              [redemptionId]
            );
            console.log('[Approve Redemption] Emergency status update succeeded');
          } catch (emergencyErr) {
            console.error('[Approve Redemption] Emergency status update also failed:', emergencyErr);
          }
        } finally {
          failClient.release();
        }
        throw new Error(`Stripe transfer failed: ${stripeErr.message}. Coins have been returned to user's account.`);
      }
    } else {
      // Manual payout (no Stripe Connect account found)
      console.warn('[Approve Redemption] No Stripe Connect account found for user:', {
        redemptionId,
        userId: redemption.user_id,
        payoutMethodId: redemption.payout_method_id
      });
      
      // Deduct coins immediately since admin approved (even if manual payout)
      const manualClient = await pool.connect();
      try {
        await manualClient.query('BEGIN');

        // Lock redemption row
        await manualClient.query(
          'SELECT id FROM redemption_requests WHERE id = $1 FOR UPDATE',
          [redemptionId]
        );

        // Lock user and deduct locked coins
        await manualClient.query(
          'SELECT locked_coins FROM users WHERE id = $1 FOR UPDATE',
          [redemption.user_id]
        );

        await manualClient.query(
          'UPDATE users SET locked_coins = locked_coins - $1 WHERE id = $2',
          [redemption.coins_requested, redemption.user_id]
        );

        // Create ledger entry
        const userResult = await manualClient.query(
          'SELECT coins, locked_coins FROM users WHERE id = $1',
          [redemption.user_id]
        );
        const newLocked = Number(userResult.rows[0].locked_coins) || 0;

        await manualClient.query(
          `INSERT INTO coin_transactions 
           (user_id, type, amount, balance_after, reason, ref_type, ref_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [redemption.user_id, 'redeem_approved', redemption.coins_requested, 
           newLocked, 'Redemption approved (manual payout)', 'redemption_request', redemptionId, 'completed']
        );

        await manualClient.query('COMMIT');
      } catch (err) {
        await manualClient.query('ROLLBACK');
        throw err;
      } finally {
        manualClient.release();
      }

      return { success: true, message: 'Approved (manual payout required - coins deducted)' };
    }

    return { success: true, stripe_transfer_id: stripeTransferId };
  } catch (err) {
    if (client && !clientReleased) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // Ignore rollback errors if transaction already committed/rolled back
      }
      client.release();
      clientReleased = true;
    }
    throw err;
  }
}

/**
 * Get redemption config for frontend
 */
async function getRedemptionConfig() {
  return {
    min_coins: REDEMPTION_MIN_COINS,
    max_coins: REDEMPTION_MAX_COINS,
    max_fiat_cents_per_day: REDEMPTION_MAX_FIAT_CENTS_PER_DAY,
    coins_per_usd: REDEMPTION_COINS_PER_USD,
    platform_fee_percent: REDEMPTION_PLATFORM_FEE_PERCENT,
    min_age_days: REDEMPTION_MIN_AGE_DAYS
  };
}

module.exports = {
  createRedemptionRequest,
  rejectRedemption,
  approveRedemption,
  getRedemptionConfig
};
