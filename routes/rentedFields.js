const express = require('express');
const router = express.Router();
const pool = require('../db');

// Get all rented fields
router.get('/', async (req, res) => {
    try {
        const allRentedFields = await pool.query('SELECT * FROM rented_fields');
        res.json(allRentedFields.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Get current user's rentals (farmer's rented fields) with field details
router.get('/my-rentals', async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
        }
        const result = await pool.query(
            `SELECT rf.*, f.name AS field_name, f.location AS field_location, f.category, f.subcategory,
                    f.price_per_m2, f.available_area, f.total_area, f.farmer_name AS owner_name
             FROM rented_fields rf
             JOIN fields f ON f.id = rf.field_id
             WHERE rf.renter_id = $1
             ORDER BY rf.start_date DESC`,
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Get active rentals for a field (for map / owner view)
router.get('/active-by-field', async (req, res) => {
    try {
        const { field_id } = req.query;
        if (!field_id) {
            return res.status(400).json({ error: 'Bad request', message: 'field_id query is required' });
        }
        const result = await pool.query(
            `SELECT rf.* FROM rented_fields rf
             WHERE rf.field_id = $1 AND COALESCE(rf.status, 'active') = 'active' AND (rf.end_date IS NULL OR rf.end_date >= CURRENT_DATE)`,
            [field_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Get a single rented field by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const rentedField = await pool.query('SELECT * FROM rented_fields WHERE id = $1', [id]);
        if (rentedField.rows.length === 0) {
            return res.status(404).json('Rented field not found');
        }
        res.json(rentedField.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Create a new rented field (farmer-only: farmer rents another owner's field)
router.post('/', async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
        }
        const userType = (req.user.user_type || '').toLowerCase();
        if (userType !== 'farmer') {
            return res.status(403).json({ error: 'Forbidden', message: 'Only farmers can rent fields' });
        }
        const { field_id, start_date, end_date, price, area_rented } = req.body;
        const renter_id = req.user.id;
        if (!field_id) {
            return res.status(400).json({ error: 'Bad request', message: 'field_id is required' });
        }
        const areaRentedNum = area_rented != null && area_rented !== '' ? parseFloat(area_rented) : null;
        const newRentedField = await pool.query(
            `INSERT INTO rented_fields (renter_id, field_id, start_date, end_date, price, area_rented, status) 
             VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING *`,
            [renter_id, field_id, start_date || null, end_date || null, price != null ? Number(price) : null, areaRentedNum]
        );
        res.status(201).json(newRentedField.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Update a rented field
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { renter_id, field_id, start_date, end_date, price } = req.body;
        const updateRentedField = await pool.query(
            'UPDATE rented_fields SET renter_id = $1, field_id = $2, start_date = $3, end_date = $4, price = $5 WHERE id = $6 RETURNING *',
            [renter_id, field_id, start_date, end_date, price, id]
        );
        if (updateRentedField.rows.length === 0) {
            return res.status(404).json('Rented field not found');
        }
        res.json(updateRentedField.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Delete a rented field
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deleteRentedField = await pool.query('DELETE FROM rented_fields WHERE id = $1 RETURNING *', [id]);
        if (deleteRentedField.rows.length === 0) {
            return res.status(404).json('Rented field not found');
        }
        res.json('Rented field deleted');
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;