/**
 * SQL for "does this product have a photo, and how many" without touching the
 * photos themselves.
 *
 * Product images live in the row as data URLs (`image` MEDIUMTEXT, `images`
 * JSON). Asking MySQL for CHAR_LENGTH(image) or JSON_LENGTH(images) makes it
 * read every one of those blobs off disk, even though no image is returned —
 * on a store with ~400 products that was 6–20 seconds per storefront load, and
 * it was paid even for a one-product page because the category covers ran the
 * same test across the whole store.
 *
 * `has_image` / `image_count` are STORED generated columns (ensureSchema adds
 * them), computed once on write, so a listing reads two small integers instead.
 * When a database does not have them yet, the old expressions are used, so an
 * un-migrated install keeps working — just slowly, as before.
 */

const IMAGE_COLUMNS = new Set(['image', 'images', 'has_image', 'image_count'])

const ref = (alias, column) => (alias ? `${alias}.\`${column}\`` : `\`${column}\``)

/** `has_image` and `image_count` select expressions (each aliased to its name). */
export function imageFlagColumns(names, alias = '') {
  const hasImage = names.includes('has_image')
    ? ref(alias, 'has_image')
    : names.includes('image')
      ? `CHAR_LENGTH(${ref(alias, 'image')}) > 0 AS has_image`
      : '0 AS has_image'
  const imageCount = names.includes('image_count')
    ? ref(alias, 'image_count')
    : names.includes('images')
      ? `COALESCE(JSON_LENGTH(${ref(alias, 'images')}), 0) AS image_count`
      : '0 AS image_count'
  return [hasImage, imageCount]
}

/**
 * A products column list for listings: every column except the image blobs,
 * plus the two flags. `'*'` when the column probe found nothing usable.
 */
export function productListColumns(names, alias = '') {
  const usable = names.filter((name) => !IMAGE_COLUMNS.has(name))
  if (!usable.length) return '*'
  return [...usable.map((name) => ref(alias, name)), ...imageFlagColumns(names, alias)].join(', ')
}

/** A WHERE condition: this product has a cover or at least one gallery photo. */
export function hasPhotoCondition(names, alias = '') {
  const cover = names.includes('has_image')
    ? `${ref(alias, 'has_image')} = 1`
    : names.includes('image')
      ? `CHAR_LENGTH(${ref(alias, 'image')}) > 0`
      : null
  const gallery = names.includes('image_count')
    ? `${ref(alias, 'image_count')} > 0`
    : names.includes('images')
      ? `COALESCE(JSON_LENGTH(${ref(alias, 'images')}), 0) > 0`
      : null
  const parts = [cover, gallery].filter(Boolean)
  return parts.length ? `(${parts.join(' OR ')})` : '0'
}
