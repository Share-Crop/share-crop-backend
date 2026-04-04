require('dotenv').config();
const pool = require('./db.js');

async function migrate() {
  try {
    console.log('Attempting to add webcam_url column to fields table...');
    await pool.query('ALTER TABLE fields ADD COLUMN IF NOT EXISTS webcam_url TEXT');
    console.log('Successfully added webcam_url column to fields table.');
  } catch (error) {
    console.error('Error migrating database:', error.message);
    if (error.stack) console.error(error.stack);
  } finally {
    await pool.end();
  }
}

migrate();
