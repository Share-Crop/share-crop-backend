require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function migrate() {
    try {
        const sql = `
      ALTER TABLE farms 
      ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Active',
      ADD COLUMN IF NOT EXISTS crop_type VARCHAR(100),
      ADD COLUMN IF NOT EXISTS irrigation_type VARCHAR(100),
      ADD COLUMN IF NOT EXISTS soil_type VARCHAR(100),
      ADD COLUMN IF NOT EXISTS area VARCHAR(100),
      ADD COLUMN IF NOT EXISTS monthly_revenue NUMERIC(15, 2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS planting_date TIMESTAMP,
      ADD COLUMN IF NOT EXISTS harvest_date TIMESTAMP,
      ADD COLUMN IF NOT EXISTS image TEXT;
    `;
        await pool.query(sql);
        console.log('Migration successful: Added missing columns to farms table.');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await pool.end();
    }
}

migrate();
