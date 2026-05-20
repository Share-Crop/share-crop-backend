/**
 * Run migration 052_field_harvest_workflow.sql
 * Usage: node runMigration052.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function main() {
  const migrationPath = path.join(__dirname, 'db', 'migrations', '052_field_harvest_workflow.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  await pool.query(sql);
  console.log('Done: 052_field_harvest_workflow applied.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
