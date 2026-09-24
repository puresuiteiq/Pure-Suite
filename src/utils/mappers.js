/**
 * Shared row → API-shape mappers, used by both the merchant (authenticated)
 * and public controllers so the JSON parsing lives in exactly one place.
 */

/**
 * The languages menu content can be stored in. A fourth costs no migration —
 * translations are a JSON column, not a column per language.
 */
export const SUPPORTED_LANGS = ['en', 'ar', 'ku-badini']

/**
 * Clean a submitted `{ en, ar, ku-badini }` map for storage.
 *
 * Unknown languages are dropped, values are trimmed, and blanks are removed
 * rather than stored — pickI18n treats a blank as absent, so persisting one
 * would be a value that can never be read back. An empty result returns null so
 * the column reads as "no translations" rather than an empty object.
 */
export function normalizeI18n(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const cleaned = {}
  for (const lang of SUPPORTED_LANGS) {
    const value = raw[lang]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) cleaned[lang] = trimmed
  }
  return Object.keys(cleaned).length ? cleaned : null
}

/** mysql2 returns JSON columns as raw strings; parse defensively. */
export function parseWorkingHours(value) {
  if (value == null) return []
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return []
    }
  }
  return value
}

/**
 * merchants.service_methods JSON → object, or null when not configured (so the
 * storefront knows to keep the plain checkout). Tolerates null/garbage strings.
 */
export function parseServiceMethods(value) {
  if (value == null) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value
}

/** Storefront social handles/links. Only known platforms are exposed. */
export function parseSocialLinks(value) {
  const empty = { instagram: '', whatsapp: '', snapchat: '', facebook: '', tiktok: '' }
  if (!value) return empty
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    return Object.fromEntries(
      Object.keys(empty).map((key) => [key, typeof parsed[key] === 'string' ? parsed[key].trim() : '']),
    )
  } catch {
    return empty
  }
}

/** A JSON column of per-language strings → object. Tolerates null/garbage. */
export function parseI18n(value) {
  if (!value) return {}
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * The translation for `lang`, or the fallback the merchant originally typed.
 *
 * Blank strings count as absent: the editor sends "" for a language left empty,
 * and an empty name is never better than the original.
 */
export function pickI18n(i18nValue, fallback, lang) {
  const translations = parseI18n(i18nValue)
  const chosen = lang ? translations[lang] : undefined
  return typeof chosen === 'string' && chosen.trim() ? chosen : fallback
}

/**
 * products row → menu item (price DECIMAL comes back as a string).
 *
 * `name`/`description` are resolved for `lang` so every display surface can
 * stay language-agnostic; the raw `nameI18n`/`descriptionI18n` ride along for
 * the merchant's editor, which needs all languages at once.
 */
export function mapMenuItem(row, lang, { withGallery = true, imageUrl = null } = {}) {
  const variants = parseVariants(row.variants)
  return {
    id: row.id,
    name: pickI18n(row.name_i18n, row.name, lang),
    nameI18n: parseI18n(row.name_i18n),
    description: pickI18n(row.description_i18n, row.description ?? '', lang),
    descriptionI18n: parseI18n(row.description_i18n),
    price: Number(row.price),
    // "Was" price for a discount (null = none). Shown struck-through when higher.
    originalPrice: row.original_price != null ? Number(row.original_price) : null,
    // Defaults to 'available' when the column is absent (pre-migration).
    availability: row.availability ?? 'available',
    optionName: row.option_name ?? null,
    variants,
    // Extra unpriced option groups (e.g. Size) picked alongside variants.
    attributes: parseAttributes(row.attributes),
    // Suitable age range in years (null = not specified).
    ageMin: row.age_min != null ? Number(row.age_min) : null,
    ageMax: row.age_max != null ? Number(row.age_max) : null,
    // Retail fields (null/empty for restaurants).
    brand: row.brand ?? null,
    stock: row.stock == null ? null : Number(row.stock),
    // Images.
    //
    // Public reads pass `imageUrl`, which turns every image into a URL the
    // browser fetches separately. That is what lets them be lazy-loaded and
    // cached individually — a base64 string inside JSON is downloaded whether
    // or not it is ever displayed, so `loading="lazy"` cannot help it and a
    // 30-item menu paid for 30 photos before showing one.
    //
    // Authenticated reads (the merchant's own editor, the admin's merchant
    // view) still get base64: the editor loads images into a form and saves
    // them back, so it needs the data itself.
    ...(imageUrl
      ? {
          image: row.image_count > 0 || row.has_image ? imageUrl(row.id, 0, row.updated_at) : null,
          ...(withGallery
            ? {
                images: Array.from({ length: Number(row.image_count) || 0 }, (_, i) =>
                  imageUrl(row.id, i, row.updated_at),
                ),
              }
            : {}),
        }
      : {
          ...(withGallery ? { images: parseImages(row.images) } : {}),
          image: row.image ?? parseImages(row.images)[0] ?? null,
        }),
  }
}

export function parseVariants(value) {
  if (!value) return []
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) return []
    // `value` is the current field; tolerate the pre-migration `size_name` so a
    // not-yet-migrated row still resolves.
    return parsed.map((variant) => ({
      value: variant.value ?? variant.size_name ?? '',
      price: Number(variant.price),
    }))
  } catch {
    return []
  }
}

/**
 * Product attribute groups → [{ name, values: [string] }]. These are extra,
 * unpriced option groups (e.g. Size S/M/L/XL) the customer picks alongside the
 * priced `variants`. Tolerates null/garbage; returns [] when unset.
 */
export function parseAttributes(value) {
  if (!value) return []
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((group) => ({
        name: String(group?.name ?? ''),
        values: Array.isArray(group?.values)
          ? group.values.map((v) => String(v ?? '')).filter(Boolean)
          : [],
        // Optional map of value → hex, so a colour option renders as a swatch.
        colors:
          group?.colors && typeof group.colors === 'object' && !Array.isArray(group.colors)
            ? group.colors
            : {},
      }))
      .filter((group) => group.name && group.values.length)
  } catch {
    return []
  }
}

/** Product image gallery → array of URLs (tolerates a bare string or null). */
export function parseImages(value) {
  if (!value) return []
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed.filter(Boolean) : []
  } catch {
    return []
  }
}

/** Nest product rows under their category rows, preserving order. */
export function groupMenu(categoryRows, productRows, lang, options) {
  const byCategory = new Map()
  for (const c of categoryRows) {
    byCategory.set(c.id, {
      id: c.id,
      name: pickI18n(c.name_i18n, c.name, lang),
      nameI18n: parseI18n(c.name_i18n),
      items: [],
    })
  }
  for (const p of productRows) {
    byCategory.get(p.category_id)?.items.push(mapMenuItem(p, lang, options))
  }
  return [...byCategory.values()]
}

/** reviews row → review shape (query must alias created_at → `date`). */
export function mapReview(row) {
  return {
    id: row.id,
    customerName: row.customer_name,
    rating: Number(row.rating),
    comment: row.comment ?? '',
    date: row.date,
  }
}

/**
 * merchant row → profile shape.
 *
 * `logoUrl`, when given, replaces the base64 logo with a URL for the same
 * reason menu images become URLs on public reads — see mapMenuItem.
 */
export function mapProfile(merchantId, row, { logoUrl = null } = {}) {
  return {
    merchantId: String(merchantId),
    // Readable storefront segment; null before db:add-slug, callers fall back
    // to merchantId so the link keeps working either way.
    slug: row.slug ?? null,
    businessName: row.business_name ?? '',
    businessType: row.business_type ?? 'restaurant',
    // The merchant row is fetched with SELECT * (deliberately, so a missing
    // column cannot break it), so the logo itself is already here — testing it
    // directly is simpler than asking the database for a flag.
    logo: logoUrl ? (row.logo ? logoUrl(row.updated_at) : null) : (row.logo ?? null),
    phone: row.phone ?? '',
    address: row.address ?? '',
    description: row.description ?? '',
    isOpen: Boolean(row.is_open),
    // Defaults to true when the column is absent (pre-migration) or null.
    reviewsEnabled: row.reviews_enabled == null ? true : Boolean(row.reviews_enabled),
    // Whether the storefront shows its top banner at all. Same default: on
    // when the column is absent (before db:add-banners) or null.
    showBanner: row.show_banner == null ? true : Boolean(row.show_banner),
    // Storefront brand colours. null = not set → the storefront applies its
    // green default (so pre-migration / un-customised merchants are unchanged).
    accentColor: row.accent_color ?? null,
    accentShadow: row.accent_shadow ?? null,
    // Admin-panel brand colours (separate from the storefront accent above).
    // null = not set → the panel applies its default amber.
    panelColor: row.panel_color ?? null,
    panelShadow: row.panel_shadow ?? null,
    storefrontBackground: row.storefront_background ?? null,
    storefrontBackgroundShadow: row.storefront_background_shadow ?? null,
    // Same idea, for dark mode. null = not set → the storefront applies its
    // flat near-black default (dark mode never inherits the light colours).
    storefrontBackgroundDark: row.storefront_background_dark ?? null,
    storefrontBackgroundShadowDark: row.storefront_background_shadow_dark ?? null,
    // Price text colour, independent of accent_color. null = not set → the
    // storefront falls back to the merchant's accent colour.
    priceColor: row.price_color ?? null,
    // Exact map location, picked via a draggable-pin map in the merchant
    // admin. mysql2 returns DECIMAL columns as strings; null = not set → the
    // storefront's address chip renders as plain text with nothing to link to.
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    // Order service methods + delivery zones/fees; null = not configured.
    serviceMethods: parseServiceMethods(row.service_methods),
    socialLinks: parseSocialLinks(row.social_links),
    workingHours: parseWorkingHours(row.working_hours),
  }
}
