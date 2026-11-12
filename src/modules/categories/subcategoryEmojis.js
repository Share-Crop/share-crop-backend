/**
 * Subcategory / product-type name → emoji.
 * Used to suggest Twemoji 72×72 PNGs and persist them into product_category_icons.
 */

const TWEMOJI_VERSION = '15.1.0';
const TWEMOJI_BASE = `https://cdn.jsdelivr.net/gh/jdecked/twemoji@${TWEMOJI_VERSION}/assets/72x72`;

/** Exact-name map (case-insensitive lookup via normalizeKey). */
const SUBCATEGORY_EMOJI_MAP = {
  // Fruits
  'Green Apple': '🍏',
  'Red Apple': '🍎',
  Apple: '🍎',
  'Green Capsicum': '🫑',
  'Red Capsicum': '🌶️',
  'Green Grapes': '🍇',
  'Red Grapes': '🍇',
  'Purple Grapes': '🍇',
  'Yellow Onions': '🧅',
  'Red Onions': '🧅',
  Peach: '🍑',
  Strawberry: '🍓',
  Tangerine: '🍊',
  Watermelon: '🍉',
  Avocados: '🥑',
  Avocado: '🥑',
  Mango: '🥭',
  Grapes: '🍇',
  Banana: '🍌',
  Lemon: '🍋',
  Lime: '🍋',
  Cherry: '🍒',
  Cherries: '🍒',
  Pear: '🍐',
  Pineapple: '🍍',
  Kiwi: '🥝',
  Coconut: '🥥',
  Blueberry: '🫐',
  Blueberries: '🫐',
  Melon: '🍈',
  Orange: '🍊',
  Apple: '🍎',
  Kino: '🍊',
  Quince: '🍐',
  Fig: '🟤',
  Date: '🌴',
  Pomegranate: '🍎',
  Papaya: '🧡',
  Guava: '🟢',

  // Vegetables
  Corn: '🌽',
  Eggplant: '🍆',
  Tomato: '🍅',
  Broccoli: '🥦',
  Capsicum: '🫑',
  Pepper: '🫑',
  Peppers: '🫑',
  Carrot: '🥕',
  Onions: '🧅',
  Onion: '🧅',
  Potatoes: '🥔',
  Potato: '🥔',
  'Salad Greens': '🥬',
  Lettuce: '🥬',
  Cucumber: '🥒',
  Garlic: '🧄',
  Chili: '🌶️',
  Chilli: '🌶️',
  'Hot Pepper': '🌶️',
  Leafy: '🥬',
  Spinach: '🥬',
  Cabbage: '🥬',
  Cauliflower: '🥦',
  Pumpkin: '🎃',
  Squash: '🎃',
  Bean: '🫘',
  Beans: '🫘',
  Pea: '🟢',
  Peas: '🟢',
  Mushroom: '🍄',
  Mushrooms: '🍄',
  Radish: '🟥',
  Beet: '🟥',
  Beetroot: '🟥',
  Ginger: '🫚',
  Herbs: '🌿',
  Herb: '🌿',
  Basil: '🌿',
  Mint: '🌿',
  Cilantro: '🌿',
  Parsley: '🌿',

  // Meat / seafood / dairy
  Bacon: '🥓',
  Chicken: '🍗',
  Pork: '🥩',
  Beef: '🥩',
  Meat: '🥩',
  Fish: '🐟',
  Shrimp: '🦐',
  Crab: '🦀',
  Lobster: '🦞',
  'Octopus & Squid': '🐙',
  Octopus: '🐙',
  Squid: '🦑',
  'Bivalves & Clams': '🦪',
  Clams: '🦪',
  Oyster: '🦪',
  Butter: '🧈',
  Cheese: '🧀',
  Cheeses: '🧀',
  Eggs: '🥚',
  Egg: '🥚',
  Milk: '🥛',
  Yogurt: '🥛',
  Yoghurt: '🥛',

  // Bakery / snacks / oils / seeds / beverages / canned / frozen / deli
  Bagels: '🥯',
  Bread: '🍞',
  Cookies: '🍪',
  Muffins: '🧁',
  Pies: '🥧',
  Tortillas: '🫓',
  Nuts: '🥜',
  Popcorn: '🍿',
  Pretzels: '🥨',
  'Coconut Oil': '🥥',
  'Olive Oil': '🫒',
  'Peanut Oil': '🥜',
  'Sunflower Oil': '🌻',
  Hibiscus: '🌺',
  'Rice Seeds': '🌾',
  Rice: '🍚',
  Rose: '🌹',
  Seeds: '🌱',
  Beer: '🍺',
  Coffee: '☕',
  Juice: '🧃',
  Soda: '🥤',
  Teabags: '🍵',
  Tea: '🍵',
  Wine: '🍷',
  Fruit: '🍎',
  'Pasta Sauce': '🍝',
  Soup: '🍲',
  Vegetables: '🥬',
  Salami: '🥩',
  'Ice cream': '🍦',
  Pizza: '🍕',
  'Ready Meals': '🍱',

  // Parent-ish fallbacks
  Fruits: '🍎',
  Beverages: '🥤',
  Dairy: '🧀',
  Deli: '🥪',
  'Fish & Seafood': '🐟',
  'Frozen Foods': '🧊',
  'Bread & Bakery': '🍞',
  'Canned Goods': '🥫',
  Oil: '🫒',
  Snacks: '🍿',
};

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const NORMALIZED_MAP = (() => {
  const out = new Map();
  for (const [name, emoji] of Object.entries(SUBCATEGORY_EMOJI_MAP)) {
    out.set(normalizeKey(name), emoji);
  }
  return out;
})();

/** Convert emoji character(s) to Twemoji hex codepoint path segment. */
function emojiToTwemojiCodepoints(emoji) {
  const chars = Array.from(String(emoji || ''));
  const codes = [];
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp == null) continue;
    // Skip variation selectors / ZWJ handled by including ZWJ when present
    if (cp === 0xfe0f || cp === 0xfe0e) continue;
    codes.push(cp.toString(16));
  }
  return codes.join('-');
}

function twemojiPngUrl(emoji) {
  const codepoints = emojiToTwemojiCodepoints(emoji);
  if (!codepoints) return null;
  return `${TWEMOJI_BASE}/${codepoints}.png`;
}

/**
 * Resolve best emoji for a product-type / subcategory title.
 * Exact match first, then starts-with / includes against known keys.
 */
function resolveEmojiForTitle(title) {
  const q = normalizeKey(title);
  if (!q || q.length < 2) return null;

  if (NORMALIZED_MAP.has(q)) {
    const emoji = NORMALIZED_MAP.get(q);
    return { emoji, match: 'exact', twemojiUrl: twemojiPngUrl(emoji) };
  }

  // Prefer longest key that the query starts with or contains
  let best = null;
  for (const [key, emoji] of NORMALIZED_MAP.entries()) {
    if (q.startsWith(key) || key.startsWith(q) || q.includes(key) || key.includes(q)) {
      if (!best || key.length > best.key.length) {
        best = { key, emoji };
      }
    }
  }
  if (!best) return null;
  return {
    emoji: best.emoji,
    match: 'fuzzy',
    matchedKey: best.key,
    twemojiUrl: twemojiPngUrl(best.emoji),
  };
}

function resolveTwemojiUrlForTitle(title) {
  return resolveEmojiForTitle(title)?.twemojiUrl || null;
}

module.exports = {
  TWEMOJI_VERSION,
  TWEMOJI_BASE,
  SUBCATEGORY_EMOJI_MAP,
  normalizeKey,
  emojiToTwemojiCodepoints,
  twemojiPngUrl,
  resolveEmojiForTitle,
  resolveTwemojiUrlForTitle,
};
