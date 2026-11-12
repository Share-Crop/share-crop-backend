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
    'Apple',
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

function findParentKey(merged, parentLabel) {
  const want = String(parentLabel || '').trim().toLowerCase();
  if (!want) return null;
  return Object.keys(merged).find((k) => k.toLowerCase() === want) || null;
}

function hasSubInParent(merged, parentKey, title) {
  const list = merged[parentKey] || [];
  const want = String(title || '').trim().toLowerCase();
  return list.some((s) => String(s).trim().toLowerCase() === want);
}

/**
 * Merge static categories with approved custom requests.
 * - category: new parent with itself as the default product type
 * - subcategory: product type appended under an existing parent
 */
async function mergeFieldCategories() {
  const merged = cloneStatic();
  try {
    const result = await pool.query(
      `SELECT title, COALESCE(request_type, 'category') AS request_type, parent_category
       FROM category_requests
       WHERE status = 'approved'
       ORDER BY created_at ASC`
    );
    for (const row of result.rows) {
      const title = String(row.title || '').trim();
      if (!title) continue;
      const type = row.request_type === 'subcategory' ? 'subcategory' : 'category';

      if (type === 'subcategory') {
        const parentKey = findParentKey(merged, row.parent_category);
        if (!parentKey) continue;
        if (!hasSubInParent(merged, parentKey, title)) {
          merged[parentKey] = [...merged[parentKey], title];
        }
        continue;
      }

      // New parent category (legacy approved rows included)
      if (!merged[title]) {
        merged[title] = [title];
      } else if (!hasSubInParent(merged, title, title)) {
        merged[title] = [...merged[title], title];
      }
    }
  } catch (err) {
    // Table / columns may not exist yet on older deploys — still return static.
    if (err.code !== '42P01' && err.code !== '42703') {
      console.warn('[fieldCategories] merge failed:', err.message);
    }
  }
  return merged;
}

module.exports = {
  STATIC_FIELD_CATEGORY_DATA,
  mergeFieldCategories,
  findParentKey,
  hasSubInParent,
};
