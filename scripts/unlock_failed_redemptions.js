/**
 * Script to unlock coins for failed redemptions
 * Run this if coins are still locked after redemptions failed
 */

require('dotenv').config();
const pool = require('../db');

async function unlockFailedRedemptions() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find all failed redemptions with locked coins
    const failedRedemptions = await client.query(
      `SELECT r.id, r.user_id, r.coins_requested, r.status
       FROM redemption_requests r
       WHERE r.status = 'failed'
       ORDER BY r.created_at DESC`
    );

    console.log(`Found ${failedRedemptions.rows.length} failed redemptions`);

    let unlocked = 0;
    for (const redemption of failedRedemptions.rows) {
      // Lock user row
      const userResult = await client.query(
        'SELECT coins, locked_coins FROM users WHERE id = $1 FOR UPDATE',
        [redemption.user_id]
      );

      if (userResult.rows.length === 0) {
        console.log(`User not found for redemption ${redemption.id}`);
        continue;
      }

      const currentLocked = Number(userResult.rows[0].locked_coins) || 0;
      const coinsRequested = Number(redemption.coins_requested) || 0;

      // Only unlock if coins are actually locked
      if (currentLocked >= coinsRequested) {
        // Unlock coins
        await client.query(
          `UPDATE users 
           SET coins = coins + $1, locked_coins = locked_coins - $1 
           WHERE id = $2`,
          [coinsRequested, redemption.user_id]
        );

        // Get updated balance for ledger
        const updatedUser = await client.query(
          'SELECT coins FROM users WHERE id = $1',
          [redemption.user_id]
        );
        const newBalance = Number(updatedUser.rows[0].coins) || 0;

        // Create ledger entry if it doesn't exist
        const existingTx = await client.query(
          `SELECT id FROM coin_transactions 
           WHERE ref_type = 'redemption_request' AND ref_id = $1 
           AND type = 'redeem_rejected'`,
          [redemption.id]
        );

        if (existingTx.rows.length === 0) {
          await client.query(
            `INSERT INTO coin_transactions 
             (user_id, type, amount, balance_after, reason, ref_type, ref_id, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [redemption.user_id, 'redeem_rejected', coinsRequested, newBalance,
             'Redemption failed - coins unlocked', 'redemption_request', redemption.id, 'completed']
          );
        }

        unlocked++;
        console.log(`Unlocked ${coinsRequested} coins for redemption ${redemption.id} (user: ${redemption.user_id})`);
      } else {
        console.log(`Skipping redemption ${redemption.id} - coins already unlocked or insufficient locked coins`);
      }
    }

    await client.query('COMMIT');
    console.log(`\n✅ Successfully unlocked coins for ${unlocked} failed redemptions`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error unlocking failed redemptions:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Run if called directly
if (require.main === module) {
  unlockFailedRedemptions()
    .then(() => {
      console.log('Done!');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed:', err);
      process.exit(1);
    });
}

module.exports = unlockFailedRedemptions;
