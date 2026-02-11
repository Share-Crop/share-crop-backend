const express = require('express');
const router = express.Router();
const pool = require('../db');
const redemptionService = require('../src/modules/redemption/redemptionService');
const packageService = require('../src/modules/coins/packageService');
const authenticate = require('../src/middleware/auth/authenticate');

// ============================================================================
// SPECIFIC ROUTES (MUST be before /:userId route to avoid route conflicts)
// ============================================================================

// Get coin packs for purchase (uses dynamic packages from database)
router.get('/packs', async (req, res) => {
    try {
        const { currency } = req.query; // Optional currency filter
        
        const packages = await packageService.getActivePackages(currency);
        
        // Format for frontend compatibility
        const packs = packages.map((pkg) => {
            // Parse decimal values from database (they come as strings)
            const discountedPrice = parseFloat(pkg.discounted_price) || 0;
            const price = parseFloat(pkg.price) || 0;
            const discountPercent = parseFloat(pkg.discount_percent) || 0;
            const pricePerCoin = parseFloat(pkg.price_per_coin) || 0;
            const discountedPricePerCoin = parseFloat(pkg.discounted_price_per_coin) || 0;
            
            const priceInCents = Math.round(discountedPrice * 100);
            return {
                id: pkg.id,
                name: pkg.name,
                description: pkg.description,
                coins: pkg.coins,
                price: price,
                discountedPrice: discountedPrice,
                currency: pkg.currency,
                currencySymbol: pkg.currency_symbol,
                discountPercent: discountPercent,
                pricePerCoin: pricePerCoin,
                discountedPricePerCoin: discountedPricePerCoin,
                isFeatured: pkg.is_featured,
                // Legacy format for backward compatibility
                usdCents: pkg.currency === 'USD' ? priceInCents : null,
                usd: pkg.currency === 'USD' ? discountedPrice.toFixed(2) : null,
            };
        });
        
        res.json({ packs });
    } catch (err) {
        console.error('Error getting coin packs:', err.message);
        res.status(500).json({ error: 'Server Error', message: err.message });
    }
});

// Get currency rates (for frontend display)
router.get('/currency-rates', async (req, res) => {
    try {
        const rates = await packageService.getCurrencyRates();
        res.json({ rates });
    } catch (err) {
        console.error('Error getting currency rates:', err.message);
        res.status(500).json({ error: 'Server Error', message: err.message });
    }
});

// Create purchase intent (Stripe Checkout) - Updated to use dynamic packages
router.post('/purchase-intent', authenticate, async (req, res) => {
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

        const { pack_id, custom_coins, currency, success_url, cancel_url } = req.body || {};
        
        let pack;
        let coins;
        let finalPrice;
        let currencyCode;
        
        // Handle custom coin purchase
        if (custom_coins && !pack_id) {
            // Use user's preferred currency if not specified
            let currencyToUse = currency;
            if (!currencyToUse) {
                const userResult = await pool.query(
                    'SELECT preferred_currency FROM users WHERE id = $1',
                    [req.user.id]
                );
                currencyToUse = userResult.rows[0]?.preferred_currency || 'USD';
            }
            
            coins = parseInt(custom_coins);
            if (isNaN(coins) || coins < 1) {
                return res.status(400).json({ error: 'Invalid coin amount' });
            }
            
            // Get currency rate
            const coinsPerUnit = await packageService.getCoinsPerCurrencyUnit(currencyToUse);
            currencyCode = currencyToUse.toUpperCase();
            
            // Calculate price: coins / coins_per_unit
            // e.g., if 1 USD = 1 coin, then 100 coins = $100
            finalPrice = coins / coinsPerUnit;
        } else {
            // Handle package purchase
            if (!pack_id) {
                return res.status(400).json({ error: 'pack_id is required' });
            }
            
            // Get package from database
            try {
                pack = await packageService.getPackageById(pack_id);
            } catch (err) {
                return res.status(404).json({ error: 'Package not found', message: err.message });
            }
            
            if (!pack.is_active) {
                return res.status(400).json({ error: 'Package is not active' });
            }
            
            coins = pack.coins;
            currencyCode = pack.currency;
            finalPrice = pack.discounted_price;
        }
        
        const priceInCents = Math.round(finalPrice * 100);
        
        // Get currency rate for description
        const coinsPerUnit = await packageService.getCoinsPerCurrencyUnit(currencyCode);
        const currencyRates = await packageService.getCurrencyRates();
        const rateInfo = currencyRates.find(r => r.currency === currencyCode);
        const currencySymbol = rateInfo?.symbol || currencyCode;
        const conversionText = `${coinsPerUnit} coins = ${currencySymbol}1.00`;
        
        // Default success/cancel URLs
        const finalSuccess = success_url || process.env.SUCCESS_URL || 'http://localhost:3000/farmer/buy-coins?success=1';
        const finalCancel = cancel_url || process.env.CANCEL_URL || 'http://localhost:3000/farmer/buy-coins?cancel=1';

        // Create Stripe Checkout Session
        let session;
        try {
            const productName = pack 
                ? (pack.discount_percent > 0 
                    ? `${pack.name} - ${pack.coins} Coins (${pack.discount_percent}% OFF)`
                    : `${pack.name} - ${pack.coins} Coins`)
                : `${coins} Custom Coins`;
            
            session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [
                    {
                        price_data: {
                            currency: currencyCode.toLowerCase(),
                            unit_amount: priceInCents,
                            product_data: {
                                name: productName,
                                description: pack?.description || conversionText,
                            },
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                success_url: (finalSuccess.includes('?') ? finalSuccess + '&' : finalSuccess + '?') + 'session_id={CHECKOUT_SESSION_ID}',
                cancel_url: finalCancel,
                client_reference_id: req.user.id,
                metadata: { 
                    user_id: req.user.id, 
                    package_id: pack?.id || null,
                    pack_id: pack?.id || null, // Legacy support
                    coins: String(coins),
                    currency: currencyCode,
                    is_custom: pack ? 'false' : 'true'
                },
            });
        } catch (err) {
            console.error('Stripe session create error:', err);
            return res.status(500).json({ error: 'Could not create checkout session', message: err.message });
        }

        // Insert purchase record (pending status)
        console.log('[Purchase Intent] Creating purchase record:', {
            userId: req.user.id,
            packageId: pack?.id || 'custom',
            packageName: pack?.name || 'Custom Coins',
            coins: coins,
            amount: finalPrice,
            currency: currencyCode,
            sessionId: session.id,
            isCustom: !pack
        });
        
        const insertResult = await pool.query(
            `INSERT INTO coin_purchases (farmer_id, amount, coins_purchased, currency, payment_ref, status, package_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [req.user.id, finalPrice, coins, currencyCode.toLowerCase(), session.id, 'pending', pack?.id || null]
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
        res.status(500).json({ error: 'Server Error', message: err.message });
    }
});

// ============================================================================
// REDEMPTION ROUTES
// ============================================================================

// Get redemption config
router.get('/redemption-config', authenticate, async (req, res) => {
    try {
        const config = await redemptionService.getRedemptionConfig();
        res.json(config);
    } catch (err) {
        console.error('Error getting redemption config:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Create redemption request
router.post('/redeem', authenticate, async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { coins_requested, payout_method_id } = req.body;

        if (!Number.isInteger(coins_requested) || coins_requested <= 0) {
            return res.status(400).json({ error: 'Invalid coins_requested' });
        }

        const result = await redemptionService.createRedemptionRequest(
            req.user.id,
            coins_requested,
            payout_method_id || null
        );

        res.status(201).json(result);
    } catch (err) {
        console.error('[Redeem] Error:', err.message);
        if (err.message.includes('Insufficient') || err.message.includes('pending')) {
            return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: 'Server Error', message: err.message });
    }
});

// Get user's redemption requests
router.get('/redemption-requests', authenticate, async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const result = await pool.query(
            `SELECT r.id, r.coins_requested, r.payout_amount_cents, r.status, 
                    r.created_at, r.reviewed_at, r.admin_notes,
                    pm.display_label as payout_method_label, pm.method_type
             FROM redemption_requests r
             LEFT JOIN user_payout_methods pm ON pm.id = r.payout_method_id
             WHERE r.user_id = $1
             ORDER BY r.created_at DESC
             LIMIT 50`,
            [req.user.id]
        );

        // Also get current balance
        const balanceResult = await pool.query(
            'SELECT coins, locked_coins FROM users WHERE id = $1',
            [req.user.id]
        );

        res.json({
            redemptions: result.rows,
            balance: {
                coins: Number(balanceResult.rows[0]?.coins) || 0,
                locked_coins: Number(balanceResult.rows[0]?.locked_coins) || 0
            }
        });
    } catch (err) {
        console.error('Error getting redemption requests:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// ============================================================================
// PAYOUT METHODS ROUTES
// ============================================================================

// Get user's payout methods
router.get('/payout-methods', authenticate, async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const result = await pool.query(
            `SELECT id, stripe_external_account_id, method_type, display_label, 
                    last4, bank_name_or_brand, is_default, created_at
             FROM user_payout_methods
             WHERE user_id = $1
             ORDER BY is_default DESC, created_at DESC`,
            [req.user.id]
        );

        res.json({ methods: result.rows });
    } catch (err) {
        console.error('Error getting payout methods:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Create payout method (Stripe Connect onboarding)
router.post('/payout-methods', authenticate, async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const Stripe = require('stripe');
        const stripeSecret = process.env.STRIPE_SECRET_KEY;
        if (!stripeSecret) {
            return res.status(503).json({ error: 'Stripe not configured' });
        }
        const stripe = new Stripe(stripeSecret, { apiVersion: '2023-10-16' });

        // Check if user already has a Connect account
        let connectAccountId = req.user.stripe_connect_account_id;

        if (!connectAccountId) {
            try {
                // Create Express account
                const account = await stripe.accounts.create({
                    type: 'express',
                    country: 'US', // Change based on your needs
                    email: req.user.email,
                });

                connectAccountId = account.id;

                // Store in users table
                await pool.query(
                    'UPDATE users SET stripe_connect_account_id = $1 WHERE id = $2',
                    [connectAccountId, req.user.id]
                );
            } catch (stripeErr) {
                // Handle Stripe API errors specifically
                console.error('Stripe Connect account creation error:', {
                    type: stripeErr.type,
                    code: stripeErr.code,
                    message: stripeErr.message,
                    statusCode: stripeErr.statusCode
                });

                // Check if Connect is not enabled
                if (stripeErr.type === 'invalid_request_error' && 
                    (stripeErr.message.toLowerCase().includes('connect') || 
                     stripeErr.message.toLowerCase().includes('signed up'))) {
                    return res.status(400).json({ 
                        error: 'Stripe Connect is not enabled on your account. Please enable it in your Stripe Dashboard at https://dashboard.stripe.com/settings/connect',
                        details: 'You need to enable Stripe Connect in your Stripe Dashboard before users can add payout methods.'
                    });
                }

                // Handle other Stripe errors
                if (stripeErr.type === 'api_error' || stripeErr.type === 'card_error') {
                    return res.status(503).json({ 
                        error: 'Payment service temporarily unavailable',
                        message: stripeErr.message 
                    });
                }

                // Re-throw to be caught by outer catch
                throw stripeErr;
            }
        }

        // Create account link for onboarding (return to correct role path so sync runs)
        try {
            const origin = req.headers.origin || 'http://localhost:3000';
            const rolePath = req.user.user_type === 'farmer' ? 'farmer' : 'buyer';
            const basePath = `${origin}/${rolePath}/payout-methods`;
            const accountLink = await stripe.accountLinks.create({
                account: connectAccountId,
                refresh_url: `${basePath}?refresh=1`,
                return_url: `${basePath}?return=1`,
                type: 'account_onboarding',
            });

            res.json({ url: accountLink.url, account_id: connectAccountId });
        } catch (stripeErr) {
            console.error('Stripe account link creation error:', {
                type: stripeErr.type,
                code: stripeErr.code,
                message: stripeErr.message
            });

            if (stripeErr.type === 'invalid_request_error') {
                return res.status(400).json({ 
                    error: 'Failed to create onboarding link',
                    message: stripeErr.message 
                });
            }

            throw stripeErr;
        }
    } catch (err) {
        console.error('Error creating payout method:', err.message);
        console.error('Error stack:', err.stack);
        
        // If it's already a Stripe error that was handled, don't override
        if (err.type && (err.type === 'invalid_request_error' || err.type === 'api_error')) {
            return res.status(err.statusCode || 400).json({ 
                error: err.message || 'Stripe API error' 
            });
        }

        res.status(500).json({ error: 'Server Error', message: err.message });
    }
});

// Set default payout method
router.patch('/payout-methods/:id/default', authenticate, async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { id } = req.params;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Verify ownership
            const methodResult = await client.query(
                'SELECT id FROM user_payout_methods WHERE id = $1 AND user_id = $2',
                [id, req.user.id]
            );

            if (methodResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Payout method not found' });
            }

            // Clear all defaults for this user
            await client.query(
                'UPDATE user_payout_methods SET is_default = FALSE WHERE user_id = $1',
                [req.user.id]
            );

            // Set this one as default
            await client.query(
                'UPDATE user_payout_methods SET is_default = TRUE WHERE id = $1',
                [id]
            );

            await client.query('COMMIT');
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error setting default payout method:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Delete payout method
router.delete('/payout-methods/:id', authenticate, async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { id } = req.params;

        // Verify ownership and check if referenced by any redemption
        const checkResult = await pool.query(
            `SELECT pm.id, COUNT(r.id) as redemption_count
             FROM user_payout_methods pm
             LEFT JOIN redemption_requests r ON r.payout_method_id = pm.id
             WHERE pm.id = $1 AND pm.user_id = $2
             GROUP BY pm.id`,
            [id, req.user.id]
        );

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Payout method not found' });
        }

        if (parseInt(checkResult.rows[0].redemption_count) > 0) {
            return res.status(400).json({ 
                error: 'Cannot delete payout method that is referenced by redemption requests' 
            });
        }

        await pool.query(
            'DELETE FROM user_payout_methods WHERE id = $1 AND user_id = $2',
            [id, req.user.id]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting payout method:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Sync payout methods from Stripe (call after Connect onboarding completes)
router.post('/payout-methods/sync', authenticate, async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const Stripe = require('stripe');
        const stripeSecret = process.env.STRIPE_SECRET_KEY;
        if (!stripeSecret) {
            return res.status(503).json({ error: 'Stripe not configured' });
        }
        const stripe = new Stripe(stripeSecret, { apiVersion: '2023-10-16' });

        // Get user's Connect account
        const userResult = await pool.query(
            'SELECT stripe_connect_account_id FROM users WHERE id = $1',
            [req.user.id]
        );

        if (!userResult.rows[0]?.stripe_connect_account_id) {
            return res.status(400).json({ error: 'No Stripe Connect account found. Complete onboarding first.' });
        }

        const accountId = userResult.rows[0].stripe_connect_account_id;

        // Fetch external accounts from Stripe
        let externalAccounts;
        try {
            externalAccounts = await stripe.accounts.listExternalAccounts(accountId, {
                limit: 10
            });
        } catch (stripeErr) {
            console.error('Stripe listExternalAccounts error:', {
                type: stripeErr.type,
                code: stripeErr.code,
                message: stripeErr.message,
                accountId
            });

            // Handle invalid account or Connect not enabled
            if (stripeErr.type === 'invalid_request_error') {
                if (stripeErr.message.toLowerCase().includes('connect') || 
                    stripeErr.code === 'account_invalid') {
                    return res.status(400).json({ 
                        error: 'Stripe Connect account is invalid or Connect is not enabled',
                        message: 'Please ensure Stripe Connect is enabled in your Stripe Dashboard.'
                    });
                }
                return res.status(400).json({ 
                    error: 'Failed to fetch payout methods',
                    message: stripeErr.message 
                });
            }

            if (stripeErr.type === 'api_error') {
                return res.status(503).json({ 
                    error: 'Payment service temporarily unavailable',
                    message: stripeErr.message 
                });
            }

            throw stripeErr;
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Delete existing methods for this account (will re-sync)
            await client.query(
                'DELETE FROM user_payout_methods WHERE stripe_account_id = $1',
                [accountId]
            );

            // Insert new methods
            for (const account of externalAccounts.data) {
                const isBank = account.object === 'bank_account';
                const isCard = account.object === 'card';
                
                if (!isBank && !isCard) continue;

                const displayLabel = isBank 
                    ? `Bank account ****${account.last4 || ''}`
                    : `${account.brand || 'Card'} ****${account.last4 || ''}`;

                await client.query(
                    `INSERT INTO user_payout_methods 
                     (user_id, stripe_external_account_id, stripe_account_id, method_type, 
                      display_label, last4, bank_name_or_brand, is_default)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     ON CONFLICT (user_id, stripe_external_account_id) DO UPDATE
                     SET display_label = EXCLUDED.display_label, bank_name_or_brand = EXCLUDED.bank_name_or_brand`,
                    [
                        req.user.id,
                        account.id,
                        accountId,
                        isBank ? 'bank_account' : 'debit_card',
                        displayLabel,
                        account.last4 || null,
                        (isBank ? account.bank_name : account.brand) || null,
                        false // Set default manually
                    ]
                );
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        // Return updated list
        const methodsResult = await pool.query(
            `SELECT id, stripe_external_account_id, method_type, display_label, 
                    last4, bank_name_or_brand, is_default, created_at
             FROM user_payout_methods
             WHERE user_id = $1
             ORDER BY is_default DESC, created_at DESC`,
            [req.user.id]
        );

        res.json({ methods: methodsResult.rows });
    } catch (err) {
        console.error('Error syncing payout methods:', err.message);
        console.error('Error stack:', err.stack);
        
        // If it's already a Stripe error that was handled, don't override
        if (err.type && (err.type === 'invalid_request_error' || err.type === 'api_error')) {
            return res.status(err.statusCode || 400).json({ 
                error: err.message || 'Stripe API error' 
            });
        }

        res.status(500).json({ error: 'Server Error', message: err.message });
    }
});

// ============================================================================
// USER-SPECIFIC ROUTES (must be AFTER all specific routes)
// ============================================================================

// Get user's coin balance (with locked_coins)
router.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Auth check: user can only view their own balance unless admin
        if (req.user && req.user.id !== userId && req.user.user_type !== 'admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }
        
        const result = await pool.query(
            'SELECT coins, locked_coins FROM users WHERE id = $1',
            [userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({ 
            coins: Number(result.rows[0].coins) || 0,
            locked_coins: Number(result.rows[0].locked_coins) || 0,
            total_coins: (Number(result.rows[0].coins) || 0) + (Number(result.rows[0].locked_coins) || 0)
        });
    } catch (err) {
        console.error('Error getting user coins:', err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Update user's coin balance (admin only or owner)
router.put('/:userId', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        const { coins } = req.body;
        
        // Auth check: only owner or admin
        if (req.user.id !== userId && req.user.user_type !== 'admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }
        
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

// Deduct coins from user's balance (with FOR UPDATE and auth)
router.post('/:userId/deduct', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const { userId } = req.params;
        const { amount, reason, refType, refId } = req.body;
        
        // Auth check: only owner or admin
        if (req.user.id !== userId && req.user.user_type !== 'admin') {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Forbidden' });
        }
        
        console.log('[Coin Deduct] Request:', { userId, amount, reason, refType, refId });
        
        if (typeof amount !== 'number' || amount <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid amount value' });
        }
        
        // Lock user row and get current balance (FOR UPDATE)
        const currentResult = await client.query(
            'SELECT coins FROM users WHERE id = $1 FOR UPDATE',
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

// Add coins to user's balance (admin only or owner)
router.post('/:userId/add', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        const { amount } = req.body;
        
        // Auth check: only owner or admin
        if (req.user.id !== userId && req.user.user_type !== 'admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }
        
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

module.exports = router;
