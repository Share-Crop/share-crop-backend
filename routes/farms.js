const express = require('express');
const router = express.Router();
const pool = require('../db');

// Get all farms, optionally filtered by owner_id
router.get('/', async (req, res) => {
    try {
        const { owner_id } = req.query;
        console.log('Farms API called with owner_id:', owner_id);
        let query = "SELECT * FROM farms";
        let values = [];

        if (owner_id) {
            query += " WHERE owner_id = $1";
            values.push(owner_id);
        }

        console.log('Executing query:', query, 'with values:', values);
        const allFarms = await pool.query(query, values);
        console.log('Found farms:', allFarms.rows.length);
        console.log('Farms data:', allFarms.rows);
        res.json(allFarms.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Get a single farm by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const farm = await pool.query("SELECT * FROM farms WHERE id = $1", [id]);
        if (farm.rows.length === 0) {
            return res.status(404).json({ msg: 'Farm not found' });
        }
        res.json(farm.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Create a new farm
router.post('/', async (req, res) => {
    try {
        const {
            name, location, owner_id, farmIcon, coordinates, webcamUrl, description,
            status, cropType, irrigationType, soilType, area, monthlyRevenue, progress,
            plantingDate, harvestDate, image, areaValue, areaUnit
        } = req.body;

        // Debug logging
        console.log('Farm creation request body:', req.body);

        // Properly stringify coordinates for JSONB storage
        const coordinatesJson = coordinates ? JSON.stringify(coordinates) : null;

        const newFarm = await pool.query(
            `INSERT INTO farms (
                farm_name, location, owner_id, farm_icon, coordinates, webcam_url, description,
                status, crop_type, irrigation_type, soil_type, area, monthly_revenue, progress,
                planting_date, harvest_date, image, area_value, area_unit
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
            [
                name, location, owner_id, farmIcon, coordinatesJson, webcamUrl, description,
                status || 'Active', cropType, irrigationType, soilType, area, monthlyRevenue || 0, progress || 0,
                plantingDate, harvestDate, image, areaValue, areaUnit || 'acres'
            ]
        );

        console.log('Created farm:', newFarm.rows[0]);
        res.json(newFarm.rows[0]);
    } catch (err) {
        console.error('Error creating farm:', err.message);
        res.status(500).json({ error: 'Server Error', details: err.message });
    }
});

// Map camelCase (frontend) to snake_case (DB) for farm update
function mapFarmBodyToRow(body) {
    const out = {};
    if (!body || typeof body !== 'object') return out;
    if (body.farmName !== undefined) out.farm_name = body.farmName;
    if (body.name !== undefined) out.farm_name = body.name;
    if (body.farmIcon !== undefined) out.farm_icon = body.farmIcon;
    if (body.webcamUrl !== undefined) out.webcam_url = body.webcamUrl;
    if (body.cropType !== undefined) out.crop_type = body.cropType;
    if (body.irrigationType !== undefined) out.irrigation_type = body.irrigationType;
    if (body.soilType !== undefined) out.soil_type = body.soilType;
    if (body.monthlyRevenue !== undefined) out.monthly_revenue = body.monthlyRevenue;
    if (body.plantingDate !== undefined) out.planting_date = body.plantingDate;
    if (body.harvestDate !== undefined) out.harvest_date = body.harvestDate;
    if (body.areaValue !== undefined) out.area_value = body.areaValue;
    if (body.areaUnit !== undefined) out.area_unit = body.areaUnit;
    return out;
}

// Update a farm (merge with existing so partial updates don't null out fields)
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await pool.query('SELECT * FROM farms WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ msg: 'Farm not found' });
        }

        const existingRow = existing.rows[0];
        const mapped = mapFarmBodyToRow(req.body);
        const row = { ...existingRow, ...mapped, ...req.body };

        // Ensure we use the right keys from the merged object
        const name = row.farm_name || row.name;
        const location = row.location;
        const owner_id = row.owner_id;
        const farmIcon = row.farm_icon || row.farmIcon;
        const coordinates = row.coordinates;
        const webcamUrl = row.webcam_url || row.webcamUrl;
        const description = row.description;
        const status = row.status;
        const cropType = row.crop_type || row.cropType;
        const irrigationType = row.irrigation_type || row.irrigationType;
        const soilType = row.soil_type || row.soilType;
        const area = row.area;
        const monthlyRevenue = row.monthly_revenue || row.monthlyRevenue;
        const progress = row.progress;
        const plantingDate = row.planting_date || row.plantingDate;
        const harvestDate = row.harvest_date || row.harvestDate;
        const image = row.image;
        const areaValue = row.area_value || row.areaValue;
        const areaUnit = row.area_unit || row.areaUnit;

        const coordinatesJson = coordinates ? (typeof coordinates === 'string' ? coordinates : JSON.stringify(coordinates)) : null;

        const updateFarm = await pool.query(
            `UPDATE farms SET 
                farm_name = $1, location = $2, owner_id = $3, farm_icon = $4, coordinates = $5, 
                webcam_url = $6, description = $7, status = $8, crop_type = $9, irrigation_type = $10, 
                soil_type = $11, area = $12, monthly_revenue = $13, progress = $14, 
                planting_date = $15, harvest_date = $16, image = $17, area_value = $18, area_unit = $19 
            WHERE id = $20 RETURNING *`,
            [
                name, location, owner_id, farmIcon, coordinatesJson,
                webcamUrl, description, status, cropType, irrigationType,
                soilType, area, monthlyRevenue, progress,
                plantingDate, harvestDate, image, areaValue, areaUnit, id
            ]
        );
        res.json(updateFarm.rows[0]);
    } catch (err) {
        console.error('Error updating farm:', err.message);
        res.status(500).json({ error: 'Server Error', details: err.message });
    }
});

// Delete a farm
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deleteFarm = await pool.query("DELETE FROM farms WHERE id = $1 RETURNING *", [id]);
        if (deleteFarm.rows.length === 0) {
            return res.status(404).json({ msg: 'Farm not found' });
        }
        res.json({ msg: 'Farm deleted' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;