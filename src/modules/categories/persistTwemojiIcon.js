const pool = require('../../../db');
const { resolveEmojiForTitle, twemojiPngUrl } = require('./subcategoryEmojis');

/**
 * Upsert a Twemoji PNG URL into product_category_icons for a subcategory key.
 * Does not overwrite an existing row unless `overwrite` is true.
 */
async function persistTwemojiIconForKey(categoryKey, emojiHint, { overwrite = false } = {}) {
  const key = String(categoryKey || '').trim();
  if (!key) return { saved: false, reason: 'empty_key' };

  if (!overwrite) {
    const existing = await pool.query(
      `SELECT category_key FROM product_category_icons WHERE category_key = $1 LIMIT 1`,
      [key]
    );
    if (existing.rows.length) {
      return { saved: false, reason: 'already_exists', category_key: key };
    }
  }

  let emoji = emojiHint && String(emojiHint).trim() ? String(emojiHint).trim() : null;
  if (!emoji) {
    emoji = resolveEmojiForTitle(key)?.emoji || null;
  }
  if (!emoji) {
    return { saved: false, reason: 'no_emoji', category_key: key };
  }

  const imageUrl = twemojiPngUrl(emoji);
  if (!imageUrl) {
    return { saved: false, reason: 'bad_emoji', category_key: key };
  }

  await pool.query(
    `INSERT INTO product_category_icons (category_key, image_url, emoji, source, updated_at)
     VALUES ($1, $2, $3, 'twemoji', now())
     ON CONFLICT (category_key) DO UPDATE SET
       image_url = EXCLUDED.image_url,
       emoji = EXCLUDED.emoji,
       source = EXCLUDED.source,
       updated_at = now()`,
    [key, imageUrl, emoji]
  );

  return { saved: true, category_key: key, emoji, image_url: imageUrl };
}

/**
 * Backfill Twemoji icons for every subcategory missing from product_category_icons.
 */
async function backfillMissingTwemojiIcons(categoryData) {
  const results = { inserted: 0, skipped: 0, noEmoji: 0, keys: [] };
  const keys = new Set();
  for (const subs of Object.values(categoryData || {})) {
    (subs || []).forEach((s) => {
      const t = String(s || '').trim();
      if (t) keys.add(t);
    });
  }

  for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
    const out = await persistTwemojiIconForKey(key, null, { overwrite: false });
    if (out.saved) {
      results.inserted += 1;
      results.keys.push(key);
    } else if (out.reason === 'already_exists') {
      results.skipped += 1;
    } else {
      results.noEmoji += 1;
    }
  }
  return results;
}

module.exports = {
  persistTwemojiIconForKey,
  backfillMissingTwemojiIcons,
};
