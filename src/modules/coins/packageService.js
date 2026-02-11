/**
 * Coin Package Management Service
 * Handles CRUD operations for coin packages and currency rates
 */

const pool = require('../../../db');

/**
 * Get all active currency rates
 */
async function getCurrencyRates() {
  const result = await pool.query(
    `SELECT id, currency, coins_per_unit, display_name, symbol, is_active, 
            created_at, updated_at
     FROM currency_rates
     WHERE is_active = true
     ORDER BY currency ASC`
  );
  return result.rows;
}

/**
 * Get all currency rates (including inactive) - admin only
 */
async function getAllCurrencyRates() {
  const result = await pool.query(
    `SELECT id, currency, coins_per_unit, display_name, symbol, is_active,
            created_by, updated_by, created_at, updated_at
     FROM currency_rates
     ORDER BY currency ASC`
  );
  return result.rows;
}

/**
 * Create or update currency rate
 */
async function upsertCurrencyRate(currencyData, adminUserId) {
  const { currency, coins_per_unit, display_name, symbol, is_active } = currencyData;
  
  const result = await pool.query(
    `INSERT INTO currency_rates (currency, coins_per_unit, display_name, symbol, is_active, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (currency) 
     DO UPDATE SET 
       coins_per_unit = EXCLUDED.coins_per_unit,
       display_name = EXCLUDED.display_name,
       symbol = EXCLUDED.symbol,
       is_active = EXCLUDED.is_active,
       updated_by = EXCLUDED.updated_by,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [currency.toUpperCase(), coins_per_unit, display_name, symbol, is_active !== false, adminUserId]
  );
  
  return result.rows[0];
}

/**
 * Delete currency rate (soft delete by setting is_active = false)
 */
async function deleteCurrencyRate(currency, adminUserId) {
  const result = await pool.query(
    `UPDATE currency_rates 
     SET is_active = false, updated_by = $2, updated_at = CURRENT_TIMESTAMP
     WHERE currency = $1
     RETURNING *`,
    [currency.toUpperCase(), adminUserId]
  );
  
  if (result.rows.length === 0) {
    throw new Error('Currency rate not found');
  }
  
  return result.rows[0];
}

/**
 * Get all active packages for users
 */
async function getActivePackages(currency = null) {
  let query = `
    SELECT 
      cp.id,
      cp.name,
      cp.description,
      cp.coins,
      cp.price,
      cp.currency,
      cp.discount_percent,
      cp.display_order,
      cp.is_featured,
      cr.symbol as currency_symbol,
      cr.display_name as currency_name,
      -- Calculate discounted price
      (cp.price * (1 - cp.discount_percent / 100.0)) as discounted_price,
      -- Calculate price per coin
      (cp.price / cp.coins) as price_per_coin,
      -- Calculate discounted price per coin
      ((cp.price * (1 - cp.discount_percent / 100.0)) / cp.coins) as discounted_price_per_coin
    FROM coin_packages cp
    INNER JOIN currency_rates cr ON cp.currency = cr.currency
    WHERE cp.is_active = true AND cr.is_active = true
  `;
  
  const params = [];
  if (currency) {
    query += ` AND cp.currency = $1`;
    params.push(currency.toUpperCase());
  }
  
  query += ` ORDER BY cp.display_order ASC, cp.coins ASC`;
  
  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get all packages (including inactive) - admin only
 */
async function getAllPackages() {
  const result = await pool.query(
    `SELECT 
      cp.*,
      cr.symbol as currency_symbol,
      cr.display_name as currency_name,
      (cp.price * (1 - cp.discount_percent / 100.0)) as discounted_price,
      (cp.price / cp.coins) as price_per_coin
     FROM coin_packages cp
     LEFT JOIN currency_rates cr ON cp.currency = cr.currency
     ORDER BY cp.display_order ASC, cp.created_at DESC`
  );
  return result.rows;
}

/**
 * Get package by ID
 */
async function getPackageById(packageId) {
  const result = await pool.query(
    `SELECT 
      cp.*,
      cr.symbol as currency_symbol,
      cr.display_name as currency_name,
      (cp.price * (1 - cp.discount_percent / 100.0)) as discounted_price
     FROM coin_packages cp
     LEFT JOIN currency_rates cr ON cp.currency = cr.currency
     WHERE cp.id = $1`,
    [packageId]
  );
  
  if (result.rows.length === 0) {
    throw new Error('Package not found');
  }
  
  return result.rows[0];
}

/**
 * Create new package
 */
async function createPackage(packageData, adminUserId) {
  const { name, description, coins, price, currency, discount_percent, display_order, is_active, is_featured } = packageData;
  
  // Validate currency exists and is active
  const currencyCheck = await pool.query(
    `SELECT is_active FROM currency_rates WHERE currency = $1`,
    [currency.toUpperCase()]
  );
  
  if (currencyCheck.rows.length === 0) {
    throw new Error(`Currency ${currency} not found. Please create currency rate first.`);
  }
  
  if (!currencyCheck.rows[0].is_active) {
    throw new Error(`Currency ${currency} is not active.`);
  }
  
  const result = await pool.query(
    `INSERT INTO coin_packages 
     (name, description, coins, price, currency, discount_percent, display_order, is_active, is_featured, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     RETURNING *`,
    [
      name,
      description || null,
      coins,
      price,
      currency.toUpperCase(),
      discount_percent || 0,
      display_order || 0,
      is_active !== false,
      is_featured || false,
      adminUserId
    ]
  );
  
  return result.rows[0];
}

/**
 * Update package
 */
async function updatePackage(packageId, packageData, adminUserId) {
  const { name, description, coins, price, currency, discount_percent, display_order, is_active, is_featured } = packageData;
  
  // Build dynamic update query
  const updates = [];
  const values = [];
  let paramIndex = 1;
  
  if (name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(name);
  }
  if (description !== undefined) {
    updates.push(`description = $${paramIndex++}`);
    values.push(description);
  }
  if (coins !== undefined) {
    updates.push(`coins = $${paramIndex++}`);
    values.push(coins);
  }
  if (price !== undefined) {
    updates.push(`price = $${paramIndex++}`);
    values.push(price);
  }
  if (currency !== undefined) {
    // Validate currency exists and is active
    const currencyCheck = await pool.query(
      `SELECT is_active FROM currency_rates WHERE currency = $1`,
      [currency.toUpperCase()]
    );
    
    if (currencyCheck.rows.length === 0) {
      throw new Error(`Currency ${currency} not found.`);
    }
    
    updates.push(`currency = $${paramIndex++}`);
    values.push(currency.toUpperCase());
  }
  if (discount_percent !== undefined) {
    updates.push(`discount_percent = $${paramIndex++}`);
    values.push(discount_percent);
  }
  if (display_order !== undefined) {
    updates.push(`display_order = $${paramIndex++}`);
    values.push(display_order);
  }
  if (is_active !== undefined) {
    updates.push(`is_active = $${paramIndex++}`);
    values.push(is_active);
  }
  if (is_featured !== undefined) {
    updates.push(`is_featured = $${paramIndex++}`);
    values.push(is_featured);
  }
  
  if (updates.length === 0) {
    throw new Error('No fields to update');
  }
  
  updates.push(`updated_by = $${paramIndex++}`);
  values.push(adminUserId);
  values.push(packageId);
  
  const result = await pool.query(
    `UPDATE coin_packages 
     SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE id = $${paramIndex}
     RETURNING *`,
    values
  );
  
  if (result.rows.length === 0) {
    throw new Error('Package not found');
  }
  
  return result.rows[0];
}

/**
 * Delete package (hard delete - permanently removes from database)
 */
async function deletePackage(packageId, adminUserId) {
  // Check if package exists
  const checkResult = await pool.query(
    `SELECT id, name FROM coin_packages WHERE id = $1`,
    [packageId]
  );
  
  if (checkResult.rows.length === 0) {
    throw new Error('Package not found');
  }
  
  // Check if package has been used in any purchases
  const purchaseCheck = await pool.query(
    `SELECT COUNT(*) as count FROM coin_purchases WHERE package_id = $1`,
    [packageId]
  );
  
  const purchaseCount = parseInt(purchaseCheck.rows[0].count);
  if (purchaseCount > 0) {
    throw new Error(`Cannot delete package: It has been used in ${purchaseCount} purchase(s). Deactivate it instead.`);
  }
  
  // Hard delete the package
  const result = await pool.query(
    `DELETE FROM coin_packages WHERE id = $1 RETURNING *`,
    [packageId]
  );
  
  return result.rows[0];
}

/**
 * Get currency conversion rate
 */
async function getCoinsPerCurrencyUnit(currency) {
  const result = await pool.query(
    `SELECT coins_per_unit FROM currency_rates 
     WHERE currency = $1 AND is_active = true`,
    [currency.toUpperCase()]
  );
  
  if (result.rows.length === 0) {
    throw new Error(`Currency ${currency} not found or inactive`);
  }
  
  return parseFloat(result.rows[0].coins_per_unit);
}

module.exports = {
  getCurrencyRates,
  getAllCurrencyRates,
  upsertCurrencyRate,
  deleteCurrencyRate,
  getActivePackages,
  getAllPackages,
  getPackageById,
  createPackage,
  updatePackage,
  deletePackage,
  getCoinsPerCurrencyUnit,
};
