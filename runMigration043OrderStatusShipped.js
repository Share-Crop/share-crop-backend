require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function run() {
  const migrationPath = path.join(__dirname, 'db', 'migrations', '043_orders_status_shipped.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  console.log('Running:', path.basename(migrationPath));
  await pool.query(sql);
  console.log('Done: orders.status may include shipped.');
  await pool.end();
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
