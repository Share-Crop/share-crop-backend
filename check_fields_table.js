require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function checkTable() {
    try {
        const res = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'fields'
      ORDER BY column_name;
    `);
        res.rows.forEach(r => console.log('COLUMN:', r.column_name, 'TYPE:', r.data_type));
    } catch (err) {
        console.error('Error querying table schema:', err);
    } finally {
        await pool.end();
    }
}

checkTable();
