const pool = require('../../../db');
const packageService = require('./packageService');

/**
 * Deduct coins from a user's wallet
 * Used when a buyer places an order
 */
async function deductCoins(userId, amount, options = {}) {
    const { reason, refType, refId } = options;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock user row and get current balance
        const userResult = await client.query(
            'SELECT coins FROM users WHERE id = $1 FOR UPDATE',
            [userId]
        );

        if (userResult.rows.length === 0) {
            throw new Error('User not found');
        }

        const currentCoins = Number(userResult.rows[0].coins) || 0;

        if (currentCoins < amount) {
            throw new Error(`Insufficient coins. Available: ${currentCoins}, Required: ${amount}`);
        }

        const newBalance = currentCoins - amount;

        // Update user balance
        await client.query(
            'UPDATE users SET coins = $1 WHERE id = $2',
            [newBalance, userId]
        );

        const transactionResult = await client.query(
            `INSERT INTO coin_transactions (user_id, type, amount, balance_after, reason, ref_type, ref_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
            [userId, 'debit', amount, newBalance, reason || 'Purchase', refType || null, refId || null, 'completed']
        );

        await client.query('COMMIT');
        return {
            success: true,
            transactionId: transactionResult.rows[0].id,
            newBalance
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Credit coins to a user's wallet
 * Used when a farmer's order is accepted/completed
 */
async function creditCoins(userId, amount, options = {}) {
    const { reason, refType, refId } = options;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock user row and get current balance
        const userResult = await client.query(
            'SELECT coins FROM users WHERE id = $1 FOR UPDATE',
            [userId]
        );

        if (userResult.rows.length === 0) {
            throw new Error('User not found');
        }

        const currentCoins = Number(userResult.rows[0].coins) || 0;
        const newBalance = currentCoins + amount;

        // Update user balance
        await client.query(
            'UPDATE users SET coins = $1 WHERE id = $2',
            [newBalance, userId]
        );

        const transactionResult = await client.query(
            `INSERT INTO coin_transactions (user_id, type, amount, balance_after, reason, ref_type, ref_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
            [userId, 'credit', amount, newBalance, reason || 'Credit', refType || null, refId || null, 'completed']
        );

        await client.query('COMMIT');
        return {
            success: true,
            transactionId: transactionResult.rows[0].id,
            newBalance
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Refund coins to a user
 * Used when an order is cancelled/rejected
 */
async function refundCoins(userId, amount, options = {}) {
    const { reason, refType, refId } = options;
    return await creditCoins(userId, amount, {
        reason: reason || 'Refund',
        refType: refType || 'refund',
        refId: refId
    });
}

/**
 * Calculate coin cost for a given dollar amount in a specific currency
 */
async function calculateCoinCost(dollarAmount, currency = 'USD') {
    const coinsPerUnit = await packageService.getCoinsPerCurrencyUnit(currency);
    return Math.ceil(dollarAmount * coinsPerUnit);
}

module.exports = {
    deductCoins,
    creditCoins,
    refundCoins,
    calculateCoinCost
};
