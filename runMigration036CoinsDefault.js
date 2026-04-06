require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function run() {
  const migrationPath = path.join(__dirname, 'db', 'migrations', '036_users_coins_default_zero.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  console.log('Running:', path.basename(migrationPath));
  await pool.query(sql);
  console.log('Done: users.coins default is now 0.');
  await pool.end();
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
