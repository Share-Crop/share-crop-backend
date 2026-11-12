const pool = require('../../../../db');
const { mergeFieldCategories } = require('../../categories/fieldCategories');
const { backfillMissingTwemojiIcons, persistTwemojiIconForKey } = require('../../categories/persistTwemojiIcon');
const { resolveEmojiForTitle } = require('../../categories/subcategoryEmojis');

async function list(req, res) {
  try {
    const r = await pool.query(
      `SELECT category_key, image_url, emoji, source, updated_at
       FROM product_category_icons ORDER BY category_key`
    );
    const overrides = {};
    r.rows.forEach((row) => {
      if (row.category_key && row.image_url) {
        overrides[row.category_key] = row.image_url;
      }
    });
    res.json({ rows: r.rows, overrides });
  } catch (e) {
    // Older DBs without emoji/source columns
    if (e.code === '42703') {
      try {
        const r = await pool.query(
          'SELECT category_key, image_url, updated_at FROM product_category_icons ORDER BY category_key'
        );
        const overrides = {};
        r.rows.forEach((row) => {
          if (row.category_key && row.image_url) overrides[row.category_key] = row.image_url;
        });
        return res.json({ rows: r.rows, overrides });
      } catch (e2) {
        console.error('adminProductIcons list fallback', e2);
      }
    }
    console.error('adminProductIcons list', e);
    res.status(500).json({ error: 'Failed to list product icons' });
  }
}

async function upsert(req, res) {
  try {
    const { category_key, image_url, emoji, source } = req.body || {};
    if (!category_key || typeof category_key !== 'string') {
      return res.status(400).json({ error: 'category_key is required' });
    }
    if (!image_url || typeof image_url !== 'string') {
      return res.status(400).json({ error: 'image_url is required' });
    }
    const key = category_key.trim();
    const url = image_url.trim();
    if (!key || !url) {
      return res.status(400).json({ error: 'category_key and image_url must be non-empty' });
    }
    const emojiVal = emoji != null && String(emoji).trim() ? String(emoji).trim() : null;
    const sourceVal = source != null && String(source).trim() ? String(source).trim() : 'upload';
    await pool.query(
      `INSERT INTO product_category_icons (category_key, image_url, emoji, source, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (category_key) DO UPDATE SET
         image_url = EXCLUDED.image_url,
         emoji = COALESCE(EXCLUDED.emoji, product_category_icons.emoji),
         source = EXCLUDED.source,
         updated_at = now()`,
      [key, url, emojiVal, sourceVal]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('adminProductIcons upsert', e);
    res.status(500).json({ error: 'Failed to save product icon' });
  }
}

async function remove(req, res) {
  try {
    const raw = req.query.key;
    if (!raw || typeof raw !== 'string') {
      return res.status(400).json({ error: 'query key is required' });
    }
    const key = raw.trim();
    await pool.query('DELETE FROM product_category_icons WHERE category_key = $1', [key]);
    res.json({ ok: true });
  } catch (e) {
    console.error('adminProductIcons remove', e);
    res.status(500).json({ error: 'Failed to remove product icon override' });
  }
}

/** Fill missing product types with Twemoji 72×72 PNG URLs (does not overwrite uploads). */
async function backfillTwemoji(req, res) {
  try {
    const categories = await mergeFieldCategories();
    const result = await backfillMissingTwemojiIcons(categories);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('adminProductIcons backfillTwemoji', e);
    res.status(500).json({ error: e.message || 'Failed to backfill Twemoji icons' });
  }
}

/** Save Twemoji icon for one subcategory key (missing only unless overwrite=true). */
async function saveTwemojiForKey(req, res) {
  try {
    const key = String(req.body?.category_key || '').trim();
    const emojiHint = req.body?.emoji != null ? String(req.body.emoji).trim() : null;
    const overwrite = Boolean(req.body?.overwrite);
    if (!key) return res.status(400).json({ error: 'category_key is required' });
    const resolved = emojiHint || resolveEmojiForTitle(key)?.emoji || null;
    const out = await persistTwemojiIconForKey(key, resolved, { overwrite });
    if (!out.saved && out.reason === 'no_emoji') {
      return res.status(404).json({ error: `No emoji mapping for “${key}”`, ...out });
    }
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('adminProductIcons saveTwemojiForKey', e);
    res.status(500).json({ error: e.message || 'Failed to save Twemoji icon' });
  }
}

module.exports = { list, upsert, remove, backfillTwemoji, saveTwemojiForKey };
