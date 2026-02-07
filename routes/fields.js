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

// Get all fields for map (discovery/browse/buy) - any authenticated user sees all
router.get('/all', async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
        }
        const result = await pool.query('SELECT * FROM fields');
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Get fields available for a farmer to rent (other owners' fields, available = true)
// Farmer-only: used for "Rent a field" flow
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
            `SELECT * FROM fields WHERE owner_id != $1 AND (available IS NULL OR available = true) AND available_for_rent = true ORDER BY name`,
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
      rent_duration_yearly
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
    const numericRentPrice = rent_price_per_month != null && rent_price_per_month !== '' ? parseFloat(rent_price_per_month) : null;
    const bool = (v) => v === true || v === 'true';
    const availBuy = available_for_buy !== false && available_for_buy !== 'false';
    const availRentVal = bool(available_for_rent);
    const rentMonthly = bool(rent_duration_monthly);
    const rentQuarterly = bool(rent_duration_quarterly);
    const rentYearly = bool(rent_duration_yearly);

    const result = await pool.query(
      `INSERT INTO fields (
        name, description, coordinates, location, image, farm_id, owner_id, 
        field_size, field_size_unit, area_m2, available_area, total_area, 
        weather, has_webcam, is_own_field, category, subcategory, price, price_per_m2, 
        unit, quantity, farmer_name, available, rating, reviews, 
        production_rate, production_rate_unit, harvest_dates, shipping_option, delivery_charges,
        available_for_buy, available_for_rent, rent_price_per_month, rent_duration_monthly, rent_duration_quarterly, rent_duration_yearly
      ) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36) 
       RETURNING *`,
      [
        name, description, coordinatesJson, location, image, farm_id, owner_id,
        numericFieldSize, field_size_unit, numericAreaM2, numericAvailableArea, numericTotalArea,
        weather, has_webcam, is_own_field, category, subcategory, numericPrice, numericPricePerM2,
        unit, numericQuantity, farmer_name, available, numericRating, reviews,
        numericProductionRate, production_rate_unit, harvestDatesJson, shipping_option, numericDeliveryCharges,
        availBuy, availRentVal, numericRentPrice, rentMonthly, rentQuarterly, rentYearly
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
    shippingOption: 'shipping_option',
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
      rent_duration_yearly: _rent_duration_yearly
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
           available_area = $10, total_area = $11, weather = $12, has_webcam = $13, is_own_field = $14,
           category = $15, subcategory = $16, price = $17, price_per_m2 = $18, unit = $19, quantity = $20,
           farmer_name = $21, available = $22, rating = $23, reviews = $24,
           production_rate = $25, production_rate_unit = $26, harvest_dates = $27,
           shipping_option = $28, delivery_charges = $29, owner_id = $30,
           available_for_buy = $31, available_for_rent = $32, rent_price_per_month = $33,
           rent_duration_monthly = $34, rent_duration_quarterly = $35, rent_duration_yearly = $36
       WHERE id = $37 
       RETURNING *`,
      [
        name, description, coordinatesJson, location, image, farm_id, field_size, field_size_unit,
        area_m2, available_area, total_area, weather, has_webcam, is_own_field,
        category, subcategory, price, price_per_m2, unit, quantity, farmer_name, available, rating, reviews,
        production_rate, production_rate_unit, harvestDatesJson, shipping_option, delivery_charges, owner_id,
        available_for_buy !== false && available_for_buy !== 'false',
        availRent,
        numericRentPrice,
        bool(rent_duration_monthly),
        bool(rent_duration_quarterly),
        bool(rent_duration_yearly),
        id
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