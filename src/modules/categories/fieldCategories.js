const pool = require('../../../db');

/** Static defaults — keep in sync with frontend `fieldCategoryData.js` keys/values. */
const STATIC_FIELD_CATEGORY_DATA = {
  Beverages: ['Beer', 'Coffee', 'Juice', 'Milk', 'Soda', 'Teabags', 'Wine'],
  'Bread & Bakery': ['Bagels', 'Bread', 'Cookies', 'Muffins', 'Pies', 'Tortillas'],
  'Canned Goods': ['Fruit', 'Pasta Sauce', 'Soup', 'Vegetables'],
  Dairy: ['Butter', 'Cheese', 'Eggs', 'Milk'],
  Deli: ['Cheeses', 'Salami'],
  'Fish & Seafood': ['Bivalves & Clams', 'Crab', 'Fish', 'Lobster', 'Octopus & Squid', 'Shrimp'],
  'Frozen Foods': ['Fish', 'Ice cream', 'Pizza', 'Potatoes', 'Ready Meals'],
  Fruits: [
    'Green Apple',
    'Red Apple',
    'Peach',
    'Strawberry',
    'Tangerine',
    'Watermelon',
    'Avocados',
    'Mango',
    'Grapes',
    'Banana',
  ],
  Vegetables: [
    'Corn',
    'Eggplant',
    'Lemon',
    'Tomato',
    'Broccoli',
    'Capsicum',
    'Carrot',
    'Onions',
    'Potatoes',
    'Salad Greens',
  ],
  Meat: ['Bacon', 'Chicken', 'Pork', 'Beef'],
  Oil: ['Coconut Oil', 'Olive Oil', 'Peanut Oil', 'Sunflower Oil'],
  Seeds: ['Hibiscus', 'Rice Seeds', 'Rose'],
  Snacks: ['Nuts', 'Popcorn', 'Pretzels'],
};

function cloneStatic() {
  const out = {};
  for (const [k, arr] of Object.entries(STATIC_FIELD_CATEGORY_DATA)) {
    out[k] = [...arr];
  }
  return out;
}

/**
 * Merge static categories with approved custom titles.
 * Each approved title becomes a parent category with itself as the only subcategory
 * (so both create-field dropdowns work without extra admin fields).
 */
async function mergeFieldCategories() {
  const merged = cloneStatic();
  try {
    const result = await pool.query(
      `SELECT title FROM category_requests
       WHERE status = 'approved'
       ORDER BY title ASC`
    );
    for (const row of result.rows) {
      const title = String(row.title || '').trim();
      if (!title) continue;
      if (!merged[title]) {
        merged[title] = [title];
      } else if (!merged[title].includes(title)) {
        merged[title] = [...merged[title], title];
      }
    }
  } catch (err) {
    // Table may not exist yet on older deploys — still return static.
    if (err.code !== '42P01') {
      console.warn('[fieldCategories] merge failed:', err.message);
    }
  }
  return merged;
}

module.exports = {
  STATIC_FIELD_CATEGORY_DATA,
  mergeFieldCategories,
};
