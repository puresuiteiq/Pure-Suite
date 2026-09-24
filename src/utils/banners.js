/**
 * Storefront banners: the input rules and the row -> API shape.
 *
 * Pure (no database), so the rules deciding what a merchant can save and what a
 * customer's tap does are unit-tested directly.
 */

/**
 * Banners per merchant — the platform owner's chosen limit. Every merchant
 * gets the same number, whatever their plan or business type.
 */
export const MAX_BANNERS = 15

/** Matches merchant_banners.title. */
export const BANNER_TITLE_MAX = 120

/** What tapping a slide does: nothing, open a product, or jump to a category. */
export const BANNER_LINK_TYPES = ['none', 'product', 'category']

/**
 * The raster types a banner may be stored as.
 *
 * Not SVG. An SVG can carry script, and the storefront serves every banner from
 * the app's own domain to anyone, signed in or not: opened directly, that
 * script would run as the app (and could read the CSRF cookie, which is
 * readable by design). The merchant panel rasterises an SVG before uploading,
 * so a merchant loses nothing.
 */
const RASTER_DATA_URL = /^data:image\/(png|jpeg|webp|gif|avif);base64,./

/**
 * A banner image: a base64 raster data URL, which is what the merchant panel
 * produces from a picture chosen on the merchant's own device (downscaled in
 * the browser first).
 *
 * Links are refused on purpose — a banner is uploaded, never pointed at an
 * address on the internet — and anything else is refused at the door rather
 * than stored and rendered as a broken slide. Stricter than product images,
 * which accept any string.
 */
export function isBannerImage(value) {
  return typeof value === 'string' && RASTER_DATA_URL.test(value)
}

/**
 * Clean a create (full) or update (`partial`) body.
 *
 * A partial update returns only the fields present in the body, so switching a
 * slide off or renaming it doesn't resend — or re-version — its image.
 *
 * Returns `{ fields }`, or `{ error }` holding an ERROR_CODES key.
 */
export function normalizeBannerInput(body, { partial = false } = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const has = (key) => Object.prototype.hasOwnProperty.call(src, key)
  const fields = {}

  if (!partial || has('image')) {
    if (!isBannerImage(src.image)) return { error: 'BANNER_IMAGE_REQUIRED' }
    fields.image = src.image
  }

  if (!partial || has('title')) {
    const title = typeof src.title === 'string' ? src.title.trim().slice(0, BANNER_TITLE_MAX) : ''
    fields.title = title || null
  }

  if (!partial || has('linkType') || has('linkId')) {
    const linkType = BANNER_LINK_TYPES.includes(src.linkType) ? src.linkType : 'none'
    if (linkType === 'none') {
      fields.linkType = 'none'
      fields.linkId = null
    } else {
      const linkId = Number(src.linkId)
      if (!Number.isInteger(linkId) || linkId <= 0) return { error: 'BANNER_LINK_INVALID' }
      fields.linkType = linkType
      fields.linkId = linkId
    }
  }

  if (!partial || has('isActive')) {
    // A new banner is live unless the merchant says otherwise.
    fields.isActive = src.isActive === undefined ? true : Boolean(src.isActive)
  }

  return { fields }
}

/** The ids a banner may link to, from menu rows already loaded. */
export function linkTargetSets(categories, products) {
  return {
    category: new Set(categories.map((category) => Number(category.id))),
    product: new Set(products.map((product) => Number(product.id))),
  }
}

/**
 * The merchant's menu as link choices for the banner editor: categories with
 * their products nested, names only.
 *
 * Names are what the merchant typed, never a translation — the same rule as
 * their menu editor (see getMyMenu).
 */
export function groupLinkTargets(categories, products) {
  const byCategory = new Map(
    categories.map((category) => [
      Number(category.id),
      { id: Number(category.id), name: category.name, items: [] },
    ]),
  )
  for (const product of products) {
    byCategory
      .get(Number(product.category_id))
      ?.items.push({ id: Number(product.id), name: product.name })
  }
  return [...byCategory.values()]
}

/**
 * merchant_banners row -> API shape.
 *
 * `imageUrl(id, updatedAt)` builds the image's URL; the bytes are never in the
 * row this reads. `linkTargets`, when given, turns a link whose product or
 * category has since been deleted into no link, so a slide never opens
 * something that isn't there.
 */
export function mapBanner(row, { imageUrl = null, linkTargets = null } = {}) {
  let linkType = BANNER_LINK_TYPES.includes(row.link_type) ? row.link_type : 'none'
  let linkId = row.link_id == null ? null : Number(row.link_id)
  const dangling = linkTargets && linkType !== 'none' && !linkTargets[linkType]?.has(linkId)
  if (linkType === 'none' || linkId == null || dangling) {
    linkType = 'none'
    linkId = null
  }
  return {
    id: Number(row.id),
    image: imageUrl ? imageUrl(row.id, row.updated_at) : null,
    title: row.title || null,
    linkType,
    linkId,
    isActive: row.is_active == null ? true : Boolean(row.is_active),
  }
}
