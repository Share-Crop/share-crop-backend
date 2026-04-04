require('dotenv').config();
const pool = require('./db');

async function cleanUserNotifications() {
  const userId = '1a8cfbfe-779f-4116-a360-67bc1847271b';
  console.log(`Starting cleanup for user ${userId}...`);
  try {
    const result = await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    console.log(`Successfully deleted ${result.rowCount} stuck notifications for user ${userId}.`);
  } catch (err) {
    console.error('Error executing query:', err);
  } finally {
    process.exit(0);
  }
}

cleanUserNotifications();
