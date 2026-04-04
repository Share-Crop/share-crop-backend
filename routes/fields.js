const express = require('express');
const router = express.Router();
const pool = require('../db');

// Get fields: admin gets all (or by owner_id); regular users get only their own (owner_id = user.id)
router.get('/', async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user && (user.user_type === 'admin' || user.user_type === 'ADMIN');

    // Unauthenticated: require login so we know whom to filter for
    if (!user || !user.id) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required to list fields' });
    }

    let query = "SELECT * FROM fields";
    const values = [];

    if (isAdmin) {
      // Admin may optionally filter by owner_id via query
      const { owner_id } = req.query;
      if (owner_id) {
        query += " WHERE owner_id = $1";
        values.push(owner_id);
      }
    } else {
      // Non-admin: only fields owned by the current user (user-centric)
      query += " WHERE owner_id = $1";
      values.push(user.id);
    }

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Get all fields for map (discovery/browse/buy) - any authenticated user sees all.
// IMPORTANT: This endpoint is user-centric for ownership/rental flags:
// - is_own_field: true only when the field's owner_id matches the current user
// - is_rented_by_me: true only when there is an active rental for this user on that field
// - Filters out fields where harvest date has passed (for public map view)
router.get('/all', async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.id) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const result = await pool.query(
      `SELECT 
         f.*,
         (f.owner_id = $1) AS is_own_field,
         EXISTS (
           SELECT 1 
           FROM rented_fields rf
           WHERE rf.field_id = f.id
             AND rf.renter_id = $1
             AND COALESCE(rf.status, 'active') = 'active'
             AND (rf.end_date IS NULL OR rf.end_date >= CURRENT_DATE)
         ) AS is_rented_by_me
       FROM fields f
       WHERE 
         -- Always show own fields (farmer can see their own fields regardless of harvest date)
         f.owner_id = $1
         OR
         -- Show other fields only if harvest date has not passed
         (
           f.harvest_dates IS NULL 
           OR f.harvest_dates = '[]'::jsonb
           OR (
             SELECT COUNT(*)::int 
             FROM jsonb_array_elements(f.harvest_dates) AS hd 
             WHERE (hd->>'date')::date >= CURRENT_DATE
           ) > 0
         )`,
      [user.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Public endpoint - no authentication required
// Returns all fields with future harvest dates for public browsing
router.get('/public', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         f.id,
         f.name,
         f.description,
         f.coordinates,
         f.location,
         f.image,
         f.farm_id,
         f.owner_id,
         f.field_size,
         f.field_size_unit,
         f.area_m2,
         f.available_area,
         f.total_area,
         f.weather,
         f.has_webcam,
         f.webcam_url,
         f.category,
         f.price,
         f.price_per_m2,
         f.unit,
         f.quantity,
         f.production_rate,
         f.production_rate_unit,
         f.harvest_dates,
         f.shipping_option,
         f.shipping_pickup,
         f.shipping_delivery,
         f.shipping_scope,
         f.delivery_charges,
         f.subcategory,
         f.available,
         f.available_for_buy,
         f.available_for_rent,
         f.rent_price_per_month,
         f.total_area_m2,
         f.available_area_m2,
         f.display_unit,
         f.total_production,
         f.distribution_price,
         f.retail_price,
         f.app_fees,
         f.potential_income,
         u.name AS farmer_name
       FROM fields f
       LEFT JOIN users u ON f.owner_id = u.id
       WHERE 
         -- Only show fields with future harvest dates
         (
           f.harvest_dates IS NULL 
           OR f.harvest_dates = '[]'::jsonb
           OR f.harvest_dates = 'null'::jsonb
           OR (
             SELECT COUNT(*)::int 
             FROM jsonb_array_elements(f.harvest_dates) AS hd 
             WHERE (hd->>'date')::date >= CURRENT_DATE
           ) > 0
         )
         AND f.available = true
       ORDER BY f.created_at DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Get fields available for a farmer to rent (other owners' fields, available = true)
// Farmer-only: used for "Rent a field" flow
// Filters out fields where harvest date has passed
router.get('/available-to-rent', async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }
    const userType = (req.user.user_type || '').toLowerCase();
    if (userType !== 'farmer') {
      return res.status(403).json({ error: 'Forbidden', message: 'Only farmers can rent fields' });
    }
    const result = await pool.query(
      `SELECT * FROM fields 
       WHERE owner_id != $1 
         AND (available IS NULL OR available = true) 
         AND available_for_rent = true
         AND (
           harvest_dates IS NULL 
           OR harvest_dates = '[]'::jsonb
           OR (
             SELECT COUNT(*)::int 
             FROM jsonb_array_elements(harvest_dates) AS hd 
             WHERE (hd->>'date')::date >= CURRENT_DATE
           ) > 0
         )
       ORDER BY name`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Get a single field by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const field = await pool.query("SELECT * FROM fields WHERE id = $1", [id]);
    if (field.rows.length === 0) {
      return res.status(404).json({ msg: 'Field not found' });
    }
    res.json(field.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Create a new field
router.post('/', async (req, res) => {
  try {
    console.log('Creating field with data:', req.body);

    // Extract all fields that can be stored in the unified fields table
    const {
      name,
      description,
      coordinates,
      location,
      image,
      farm_id,
      owner_id,
      field_size,
      field_size_unit,
      area_m2,
      available_area,
      total_area,
      weather,
      has_webcam,
      webcam_url,
      is_own_field = true,
      category,
      subcategory,
      price,
      price_per_m2,
      unit,
      quantity,
      farmer_name,
      available = true,
      rating = 0.0,
      reviews = 0,
      production_rate,
      production_rate_unit,
      harvest_dates,
      shipping_option,
      delivery_charges,
      available_for_buy,
      available_for_rent,
      rent_price_per_month,
      rent_duration_monthly,
      rent_duration_quarterly,
      rent_duration_yearly,
      total_production,
      distribution_price,
      retail_price,
      virtual_production_rate,
      virtual_cost_per_unit,
      app_fees,
      potential_income,
      user_virtual_rent,
      shipping_scope,
      shipping_pickup,
      shipping_delivery,
      total_area_m2,
      available_area_m2,
      display_unit,
    } = req.body;

    // Validation: if available_for_rent then require rent_price_per_month and at least one duration
    const availRent = available_for_rent === true || available_for_rent === 'true';
    if (availRent) {
      const priceOk = rent_price_per_month != null && rent_price_per_month !== '' && !isNaN(parseFloat(rent_price_per_month));
      const anyDuration = rent_duration_monthly === true || rent_duration_monthly === 'true' ||
        rent_duration_quarterly === true || rent_duration_quarterly === 'true' ||
        rent_duration_yearly === true || rent_duration_yearly === 'true';
      if (!priceOk || !anyDuration) {
        return res.status(400).json({
          error: 'When "available for rent" is enabled, rent price per month and at least one rent duration (monthly, quarterly, yearly) are required'
        });
      }
    }

    // Stringify JSON fields if they exist
    const coordinatesJson = coordinates ? JSON.stringify(coordinates) : null;
    const harvestDatesJson = harvest_dates ? JSON.stringify(harvest_dates) : null;

    // Convert numeric fields to proper types
    const numericFieldSize = field_size ? parseFloat(field_size) : null;
    const numericAreaM2 = area_m2 ? parseFloat(area_m2) : null;
    const numericAvailableArea = available_area ? parseFloat(available_area) : null;
    const numericTotalArea = total_area ? parseFloat(total_area) : null;
    const numericPrice = price ? parseFloat(price) : null;
    const numericPricePerM2 = price_per_m2 ? parseFloat(price_per_m2) : null;
    const numericQuantity = quantity ? parseFloat(quantity) : null;
    const numericRating = rating ? parseFloat(rating) : 0.0;
    const numericProductionRate = production_rate ? parseFloat(production_rate) : null;
    const numericDeliveryCharges = delivery_charges ? parseFloat(delivery_charges) : null;
    const numericTotalProduction = total_production ? parseFloat(total_production) : null;
    const numericDistributionPrice = distribution_price ? parseFloat(distribution_price) : null;
    const numericRetailPrice = retail_price ? parseFloat(retail_price) : null;
    const numericVirtualProd = virtual_production_rate ? parseFloat(virtual_production_rate) : null;
    const numericVirtualCost = virtual_cost_per_unit ? parseFloat(virtual_cost_per_unit) : null;
    const numericAppFees = app_fees ? parseFloat(app_fees) : null;
    const numericPotentialIncome = potential_income ? parseFloat(potential_income) : null;
    const numericUserRent = user_virtual_rent ? parseFloat(user_virtual_rent) : null;
    const numericRentPrice = rent_price_per_month != null && rent_price_per_month !== '' ? parseFloat(rent_price_per_month) : null;
    const bool = (v) => v === true || v === 'true';
    const availBuy = available_for_buy !== false && available_for_buy !== 'false';
    const availRentVal = bool(available_for_rent);
    const rentMonthly = bool(rent_duration_monthly);
    const rentQuarterly = bool(rent_duration_quarterly);
    const rentYearly = bool(rent_duration_yearly);
    const numericTotalAreaM2 = total_area_m2 ? parseFloat(total_area_m2) : null;
    const numericAvailableAreaM2 = available_area_m2 ? parseFloat(available_area_m2) : null;

    // Handle delivery_charges - can be JSON array string, array, or numeric (backward compatibility)
    let deliveryChargesJson = null;
    if (delivery_charges) {
      if (typeof delivery_charges === 'string') {
        try {
          deliveryChargesJson = JSON.parse(delivery_charges);
        } catch {
          // If not valid JSON, try parsing as number (backward compatibility)
          const num = parseFloat(delivery_charges);
          if (!isNaN(num)) {
            deliveryChargesJson = JSON.stringify([{ upto: null, amount: num }]);
          }
        }
      } else if (Array.isArray(delivery_charges)) {
        deliveryChargesJson = delivery_charges;
      } else {
        // Numeric value
        const num = parseFloat(delivery_charges);
        if (!isNaN(num)) {
          deliveryChargesJson = JSON.stringify([{ upto: null, amount: num }]);
        }
      }
    }

    const result = await pool.query(
      `INSERT INTO fields (
        name, description, coordinates, location, image, farm_id, owner_id, 
        field_size, field_size_unit, area_m2, available_area, total_area, 
        weather, has_webcam, webcam_url, is_own_field, category, subcategory, price, price_per_m2, 
        unit, quantity, farmer_name, available, rating, reviews, 
        production_rate, production_rate_unit, harvest_dates, shipping_option, delivery_charges,
        available_for_buy, available_for_rent, rent_price_per_month, rent_duration_monthly, rent_duration_quarterly, rent_duration_yearly,
        total_production, distribution_price, retail_price, virtual_production_rate, virtual_cost_per_unit, app_fees, potential_income, user_virtual_rent,
        total_area_m2, available_area_m2, display_unit, shipping_scope, shipping_pickup, shipping_delivery

        ) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51) 
       RETURNING *`,
      [
        name, description, coordinatesJson, location, image, farm_id, owner_id,
        numericFieldSize, field_size_unit, numericAreaM2, numericAvailableArea, numericTotalArea,
        weather, has_webcam, webcam_url, is_own_field, category, subcategory, numericPrice, numericPricePerM2,
        unit, numericQuantity, farmer_name, available, numericRating, reviews,
        numericProductionRate, production_rate_unit, harvestDatesJson, shipping_option, deliveryChargesJson,
        availBuy, availRentVal, numericRentPrice, rentMonthly, rentQuarterly, rentYearly,
        numericTotalProduction, numericDistributionPrice, numericRetailPrice, numericVirtualProd, numericVirtualCost, numericAppFees, numericPotentialIncome, numericUserRent
        , numericTotalAreaM2, numericAvailableAreaM2, display_unit, shipping_scope, shipping_pickup, shipping_delivery
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating field:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to create field', details: error.message });
  }
});

// Map camelCase (frontend) to snake_case (DB) for update body
function mapBodyToRow(body) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  const map = {
    productName: 'name',
    shippingScope: 'shipping_scope',
    harvestDates: 'harvest_dates',
    farmId: 'farm_id',
    fieldSize: 'field_size',
    fieldSizeUnit: 'field_size_unit',
    productionRate: 'production_rate',
    productionRateUnit: 'production_rate_unit',
    sellingAmount: 'quantity',
    sellingPrice: 'price',
    deliveryCharges: 'delivery_charges',
    hasWebcam: 'has_webcam',
    webcamUrl: 'webcam_url',
    shippingOption: 'shipping_option',
    totalProduction: 'total_production',
    distributionPrice: 'distribution_price',
    retailPrice: 'retail_price',
    virtualProductionRate: 'virtual_production_rate',
    virtualCostPerUnit: 'virtual_cost_per_unit',
    appFees: 'app_fees',
    potentialIncome: 'potential_income',
    userVirtualRent: 'user_virtual_rent',
  };
  for (const [camel, snake] of Object.entries(map)) {
    if (body[camel] !== undefined) out[snake] = body[camel];
  }
  return out;
}

// Update a field (merges req.body with existing row so partial updates don't null out required columns)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await pool.query('SELECT * FROM fields WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Field not found' });
    }
    const mapped = mapBodyToRow(req.body);
    const row = { ...existing.rows[0], ...mapped, ...req.body };
    const existingRow = existing.rows[0];

    // Use existing values when merged value is null/undefined so we never violate NOT NULL
    const {
      name: _name,
      description: _description,
      coordinates: _coordinates,
      location: _location,
      image: _image,
      farm_id: _farm_id,
      field_size: _field_size,
      field_size_unit: _field_size_unit,
      area_m2: _area_m2,
      available_area: _available_area,
      total_area: _total_area,
      weather: _weather,
      has_webcam: _has_webcam,
      webcam_url: _webcam_url,
      is_own_field: _is_own_field,
      category: _category,
      subcategory: _subcategory,
      price: _price,
      price_per_m2: _price_per_m2,
      unit: _unit,
      quantity: _quantity,
      farmer_name: _farmer_name,
      available: _available,
      rating: _rating,
      reviews: _reviews,
      production_rate: _production_rate,
      production_rate_unit: _production_rate_unit,
      harvest_dates: _harvest_dates,
      shipping_option: _shipping_option,
      delivery_charges: _delivery_charges,
      owner_id: _owner_id,
      available_for_buy: _available_for_buy,
      available_for_rent: _available_for_rent,
      rent_price_per_month: _rent_price_per_month,
      rent_duration_monthly: _rent_duration_monthly,
      rent_duration_quarterly: _rent_duration_quarterly,
      rent_duration_yearly: _rent_duration_yearly,
      total_production: _total_production,
      distribution_price: _distribution_price,
      retail_price: _retail_price,
      virtual_production_rate: _virtual_production_rate,
      virtual_cost_per_unit: _virtual_cost_per_unit,
      app_fees: _app_fees,
      potential_income: _potential_income,
      user_virtual_rent: _user_virtual_rent
    } = row;

    const name = _name ?? existingRow.name;
    const description = _description ?? existingRow.description;
    const coordinates = _coordinates ?? existingRow.coordinates;
    const location = _location ?? existingRow.location;
    const image = _image ?? existingRow.image;
    const farm_id = _farm_id ?? existingRow.farm_id;
    const field_size = _field_size ?? existingRow.field_size;
    const field_size_unit = _field_size_unit ?? existingRow.field_size_unit;
    const area_m2 = _area_m2 ?? existingRow.area_m2;
    const available_area = _available_area ?? existingRow.available_area;
    const total_area = _total_area ?? existingRow.total_area;
    const weather = _weather ?? existingRow.weather;
    const has_webcam = _has_webcam ?? existingRow.has_webcam;
    const webcam_url = _webcam_url ?? existingRow.webcam_url;
    const is_own_field = _is_own_field ?? existingRow.is_own_field;
    const category = _category ?? existingRow.category;
    const subcategory = _subcategory ?? existingRow.subcategory;
    const price = _price ?? existingRow.price;
    const price_per_m2 = _price_per_m2 ?? existingRow.price_per_m2;
    const unit = _unit ?? existingRow.unit;
    const quantity = _quantity ?? existingRow.quantity;
    const farmer_name = _farmer_name ?? existingRow.farmer_name;
    const available = _available ?? existingRow.available;
    const rating = _rating ?? existingRow.rating;
    const reviews = _reviews ?? existingRow.reviews;
    const production_rate = _production_rate ?? existingRow.production_rate;
    const production_rate_unit = _production_rate_unit ?? existingRow.production_rate_unit;
    const harvest_dates = _harvest_dates ?? existingRow.harvest_dates;
    const shipping_option = _shipping_option ?? existingRow.shipping_option;
    const delivery_charges = _delivery_charges ?? existingRow.delivery_charges;
    const owner_id = _owner_id ?? existingRow.owner_id;
    const available_for_buy = _available_for_buy ?? existingRow.available_for_buy;
    const available_for_rent = _available_for_rent ?? existingRow.available_for_rent;
    const rent_price_per_month = _rent_price_per_month ?? existingRow.rent_price_per_month;
    const rent_duration_monthly = _rent_duration_monthly ?? existingRow.rent_duration_monthly;
    const rent_duration_quarterly = _rent_duration_quarterly ?? existingRow.rent_duration_quarterly;
    const rent_duration_yearly = _rent_duration_yearly ?? existingRow.rent_duration_yearly;
    const total_production = _total_production ?? existingRow.total_production;
    const distribution_price = _distribution_price ?? existingRow.distribution_price;
    const retail_price = _retail_price ?? existingRow.retail_price;
    const virtual_production_rate = _virtual_production_rate ?? existingRow.virtual_production_rate;
    const virtual_cost_per_unit = _virtual_cost_per_unit ?? existingRow.virtual_cost_per_unit;
    const app_fees = _app_fees ?? existingRow.app_fees;
    const potential_income = _potential_income ?? existingRow.potential_income;
    const user_virtual_rent = _user_virtual_rent ?? existingRow.user_virtual_rent;

    const availRent = available_for_rent === true || available_for_rent === 'true';
    if (availRent) {
      const priceOk = rent_price_per_month != null && rent_price_per_month !== '' && !isNaN(parseFloat(rent_price_per_month));
      const anyDuration = rent_duration_monthly === true || rent_duration_monthly === 'true' ||
        rent_duration_quarterly === true || rent_duration_quarterly === 'true' ||
        rent_duration_yearly === true || rent_duration_yearly === 'true';
      if (!priceOk || !anyDuration) {
        return res.status(400).json({
          error: 'When "available for rent" is enabled, rent price per month and at least one rent duration (monthly, quarterly, yearly) are required'
        });
      }
    }

    const bool = (v) => v === true || v === 'true';
    const numericRentPrice = rent_price_per_month != null && rent_price_per_month !== '' ? parseFloat(rent_price_per_month) : null;

    const coordinatesJson = coordinates ? JSON.stringify(coordinates) : null;
    const harvestDatesJson = harvest_dates ? JSON.stringify(harvest_dates) : null;

    const result = await pool.query(
      `UPDATE fields 
       SET name = $1, description = $2, coordinates = $3, location = $4, image = $5, 
           farm_id = $6, field_size = $7, field_size_unit = $8, area_m2 = $9, 
           available_area = $10, total_area = $11, weather = $12, has_webcam = $13, webcam_url = $14, is_own_field = $15,
           category = $16, subcategory = $17, price = $18, price_per_m2 = $19, unit = $20, quantity = $21,
           farmer_name = $22, available = $23, rating = $24, reviews = $25,
           production_rate = $26, production_rate_unit = $27, harvest_dates = $28,
           shipping_option = $29, delivery_charges = $30, owner_id = $31,
           available_for_buy = $32, available_for_rent = $33, rent_price_per_month = $34,
           rent_duration_monthly = $35, rent_duration_quarterly = $36, rent_duration_yearly = $37,
           total_production = $39, distribution_price = $40, retail_price = $41,
           virtual_production_rate = $42, virtual_cost_per_unit = $43, app_fees = $44,
           potential_income = $45, user_virtual_rent = $46
       WHERE id = $38 
       RETURNING *`,
      [
        name, description, coordinatesJson, location, image, farm_id, field_size, field_size_unit,
        area_m2, available_area, total_area, weather, has_webcam, webcam_url, is_own_field,
        category, subcategory, price, price_per_m2, unit, quantity, farmer_name, available, rating, reviews,
        production_rate, production_rate_unit, harvestDatesJson, shipping_option, delivery_charges, owner_id,
        available_for_buy !== false && available_for_buy !== 'false',
        availRent,
        numericRentPrice,
        bool(rent_duration_monthly),
        bool(rent_duration_quarterly),
        bool(rent_duration_yearly),
        id,
        total_production ? parseFloat(total_production) : null,
        distribution_price ? parseFloat(distribution_price) : null,
        retail_price ? parseFloat(retail_price) : null,
        virtual_production_rate ? parseFloat(virtual_production_rate) : null,
        virtual_cost_per_unit ? parseFloat(virtual_cost_per_unit) : null,
        app_fees ? parseFloat(app_fees) : null,
        potential_income ? parseFloat(potential_income) : null,
        user_virtual_rent ? parseFloat(user_virtual_rent) : null
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating field:', error);
    res.status(500).json({ error: 'Failed to update field' });
  }
});

// Delete a field
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleteField = await pool.query("DELETE FROM fields WHERE id = $1 RETURNING *", [id]);
    if (deleteField.rows.length === 0) {
      return res.status(404).json({ msg: 'Field not found' });
    }
    res.json({ msg: 'Field deleted' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;