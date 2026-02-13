require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function migrate() {
    try {
        const sql = `
      ALTER TABLE farms 
      ADD COLUMN IF NOT EXISTS area_value NUMERIC(15, 2),
      ADD COLUMN IF NOT EXISTS area_unit VARCHAR(20) DEFAULT 'acres';
    `;
        await pool.query(sql);
        console.log('Migration successful: Added area_value and area_unit to farms table.');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await pool.end();
    }
}

migrate();
