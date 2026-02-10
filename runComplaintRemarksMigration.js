require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function run() {
  const file = path.join(__dirname, 'db/migrations/031_complaint_remarks.sql');
  try {
    const sql = fs.readFileSync(file, 'utf8');
    console.log('Running migration:', path.basename(file));
    await pool.query(sql);
    console.log('Migration completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

run();
