require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function checkTable() {
    try {
        const res = await pool.query(`
      SELECT column_name
      FROM information_schema.columns 
      WHERE table_name = 'farms'
      ORDER BY column_name;
    `);
        res.rows.forEach(r => console.log('COLUMN:', r.column_name));
    } catch (err) {
        console.error('Error querying table schema:', err);
    } finally {
        await pool.end();
    }
}

checkTable();
