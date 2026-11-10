require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');

async function main() {
  const sqlPath = path.join(__dirname, '../db/migrations/056_category_requests_type.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await pool.query(sql);
  const check = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'category_requests'
      AND column_name IN ('request_type', 'parent_category')
    ORDER BY column_name
  `);
  console.log('migration ok', check.rows);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
