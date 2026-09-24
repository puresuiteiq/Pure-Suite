/**
 * Validation and normalisation for menu item fields.
 *
 * These were module-private helpers inside menuController, which meant real
 * input validation — the layer standing between a public form and the database
 * — could not be reached from a test. Moving them here is a pure relocation:
 * no behaviour changes, every rule is exactly as it was.
 */

/** Merchant-set per-item availability shown on the storefront. */
export const AVAILABILITY = ['available', 'unavailable', 'out_of_stock']

export const normalizeAvailability = (v) => (AVAILABILITY.includes(v) ? v : 'available')

/** Optional "was" price for a discount: a non-negative number, else null. */
export function normalizeOriginalPrice(v) {
  if (v === '' || v == null) return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** A single age bound: a whole number in 0..150, or null when empty/invalid. */
export function normalizeAge(v) {
  if (v === '' || v == null) return null
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= 0 && n <= 150 ? n : null
}

/**
 * Normalize the [min, max] pair: drop nonsense, and if both are set but out of
 * order, swap them so min <= max.
 */
export function normalizeAgeRange(rawMin, rawMax) {
  let min = normalizeAge(rawMin)
  let max = normalizeAge(rawMax)
  if (min != null && max != null && min > max) [min, max] = [max, min]
  return { min, max }
}

/** Accept a #rgb / #rrggbb colour, lowercased; anything else → null. */
export const hexColor = (v) => {
  if (!v) return null
  const h = String(v).trim().toLowerCase()
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(h) ? h : null
}

/**
 * Extra option groups: [{ name, values: [string], colors?: {value: hex} }] —
 * deduped, trimmed, capped; colours kept only for existing values.
 */
export function normalizeAttributes(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map((group) => {
      const values = Array.isArray(group?.values)
        ? [...new Set(group.values.map((v) => String(v ?? '').trim()).filter(Boolean))].slice(0, 40)
        : []
      const colors = {}
      if (group?.colors && typeof group.colors === 'object') {
        for (const [key, val] of Object.entries(group.colors)) {
          const hex = hexColor(val)
          if (hex && values.includes(key)) colors[key] = hex
        }
      }
      const normalized = { name: String(group?.name ?? '').trim().slice(0, 40), values }
      if (Object.keys(colors).length) normalized.colors = colors
      return normalized
    })
    .filter((group) => group.name && group.values.length)
    .slice(0, 6)
}

/**
 * Priced option values, e.g. sizes. Returns `{ variants, error }` — an invalid
 * set yields an empty array and a message, never a partial write.
 */
export function normalizeVariants(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return { variants: [], error: null }
  // Accept the current `value` field and the legacy `size_name` from any older
  // client, normalising to { value, price }.
  const normalized = variants.map((variant) => ({
    value: String(variant?.value ?? variant?.size_name ?? '').trim(),
    price: Number(variant?.price),
  }))
  if (normalized.some((variant) => !variant.value || Number.isNaN(variant.price) || variant.price < 0)) {
    return { variants: [], error: 'Every variant needs a name and a valid price' }
  }
  return { variants: normalized, error: null }
}

/** Inventory: null (untracked) or a non-negative integer. */
export function normalizeStock(stock) {
  if (stock == null || stock === '') return { stock: null, error: null }
  const n = Number(stock)
  if (!Number.isInteger(n) || n < 0) return { stock: null, error: 'Stock must be a whole number of 0 or more' }
  return { stock: n, error: null }
}

/** Image gallery: array of non-empty strings (data/CDN URLs). */
export function normalizeImages(images) {
  if (!Array.isArray(images)) return []
  return images.filter((img) => typeof img === 'string' && img.length > 0)
}

/**
 * Required fields for an item. A price is only required when the item is not
 * priced by its option values instead.
 */
export function validateItem({ name, price, variants }) {
  if (!name || !name.trim()) return 'Item name is required'
  if (variants.length) return null
  const priceNum = Number(price)
  if (Number.isNaN(priceNum) || priceNum < 0) return 'A valid price is required'
  return null
}
