const packageService = require('../../coins/packageService');

/**
 * Get all packages (admin)
 */
async function listPackages(req, res) {
  try {
    const packages = await packageService.getAllPackages();
    res.json({ packages });
  } catch (err) {
    console.error('Error listing packages:', err);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
}

/**
 * Get package by ID (admin)
 */
async function getPackage(req, res) {
  try {
    const { id } = req.params;
    const pkg = await packageService.getPackageById(id);
    res.json({ package: pkg });
  } catch (err) {
    if (err.message === 'Package not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Error getting package:', err);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
}

/**
 * Create new package (admin)
 */
async function createPackage(req, res) {
  try {
    const adminUserId = req.user.id;
    const packageData = req.body;
    
    // Validate required fields
    if (!packageData.name || !packageData.coins || !packageData.price || !packageData.currency) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        required: ['name', 'coins', 'price', 'currency'] 
      });
    }
    
    const pkg = await packageService.createPackage(packageData, adminUserId);
    res.status(201).json({ package: pkg });
  } catch (err) {
    console.error('Error creating package:', err);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
}

/**
 * Update package (admin)
 */
async function updatePackage(req, res) {
  try {
    const { id } = req.params;
    const adminUserId = req.user.id;
    const packageData = req.body;
    
    const pkg = await packageService.updatePackage(id, packageData, adminUserId);
    res.json({ package: pkg });
  } catch (err) {
    if (err.message === 'Package not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Error updating package:', err);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
}

/**
 * Delete package (admin - hard delete)
 */
async function deletePackage(req, res) {
  try {
    const { id } = req.params;
    const adminUserId = req.user.id;
    
    const pkg = await packageService.deletePackage(id, adminUserId);
    res.json({ package: pkg, message: 'Package deleted successfully' });
  } catch (err) {
    if (err.message === 'Package not found') {
      return res.status(404).json({ error: err.message });
    }
    if (err.message.includes('Cannot delete package')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Error deleting package:', err);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
}

/**
 * Get all currency rates (admin)
 */
async function listCurrencyRates(req, res) {
  try {
    const rates = await packageService.getAllCurrencyRates();
    res.json({ rates });
  } catch (err) {
    console.error('Error listing currency rates:', err);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
}

/**
 * Create or update currency rate (admin)
 */
async function upsertCurrencyRate(req, res) {
  try {
    const adminUserId = req.user.id;
    const rateData = req.body;
    
    // Validate required fields
    if (!rateData.currency || rateData.coins_per_unit === undefined || !rateData.display_name || !rateData.symbol) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        required: ['currency', 'coins_per_unit', 'display_name', 'symbol'] 
      });
    }
    
    // Validate currency code format (exactly 3 uppercase letters)
    const currencyCode = rateData.currency.toUpperCase().trim();
    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      return res.status(400).json({ 
        error: 'Invalid currency code. Must be exactly 3 uppercase letters (e.g., USD, EUR, GBP)' 
      });
    }
    
    // Validate coins_per_unit is positive
    const coinsPerUnit = parseFloat(rateData.coins_per_unit);
    if (isNaN(coinsPerUnit) || coinsPerUnit <= 0) {
      return res.status(400).json({ 
        error: 'Coins per unit must be a positive number' 
      });
    }
    
    // Update currency code to validated format
    rateData.currency = currencyCode;
    rateData.coins_per_unit = coinsPerUnit;
    
    const rate = await packageService.upsertCurrencyRate(rateData, adminUserId);
    res.json({ rate });
  } catch (err) {
    console.error('Error upserting currency rate:', err);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
}

/**
 * Delete currency rate (admin - soft delete)
 */
async function deleteCurrencyRate(req, res) {
  try {
    const { currency } = req.params;
    const adminUserId = req.user.id;
    
    const rate = await packageService.deleteCurrencyRate(currency, adminUserId);
    res.json({ rate, message: 'Currency rate deactivated successfully' });
  } catch (err) {
    if (err.message === 'Currency rate not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Error deleting currency rate:', err);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
}

module.exports = {
  listPackages,
  getPackage,
  createPackage,
  updatePackage,
  deletePackage,
  listCurrencyRates,
  upsertCurrencyRate,
  deleteCurrencyRate,
};
