require('dotenv').config();
const pool = require('../db');
const { mergeFieldCategories } = require('../src/modules/categories/fieldCategories');
const { backfillMissingTwemojiIcons } = require('../src/modules/categories/persistTwemojiIcon');

async function main() {
  const categories = await mergeFieldCategories();
  const result = await backfillMissingTwemojiIcons(categories);
  console.log(JSON.stringify(result, null, 2));
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
