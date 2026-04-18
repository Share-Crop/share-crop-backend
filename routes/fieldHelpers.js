const pool = require('../db');

/**
 * Replace all gallery images for a field (max 5 URLs enforced by DB trigger per insert batch;
 * caller should pass at most 5).
 */
async function replaceFieldGalleryImages(fieldId, urls) {
  const list = (urls || [])
    .filter((u) => typeof u === 'string' && u.trim())
    .slice(0, 5)
    .map((u) => u.trim());
  await pool.query('DELETE FROM field_images WHERE field_id = $1', [fieldId]);
  for (let i = 0; i < list.length; i += 1) {
    await pool.query(
      'INSERT INTO field_images (field_id, image_url, sort_order) VALUES ($1, $2, $3)',
      [fieldId, list[i], i]
    );
  }
}

/** Attach gallery_images (array of URLs) to each row that has id */
async function attachGalleryToFieldRows(rows) {
  if (!rows || !rows.length) return rows;
  const ids = rows.map((r) => r.id).filter(Boolean);
  if (!ids.length) return rows;
  const { rows: g } = await pool.query(
    `SELECT field_id, COALESCE(json_agg(image_url ORDER BY sort_order), '[]'::json) AS gallery_images
     FROM field_images WHERE field_id = ANY($1::uuid[])
     GROUP BY field_id`,
    [ids]
  );
  const map = new Map(g.map((x) => [String(x.field_id), x.gallery_images]));
  for (const row of rows) {
    const gi = map.get(String(row.id));
    row.gallery_images = Array.isArray(gi) ? gi : [];
  }
  return rows;
}

module.exports = {
  replaceFieldGalleryImages,
  attachGalleryToFieldRows,
};
