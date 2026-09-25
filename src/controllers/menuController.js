import pool from '../config/db.js'
import { groupMenu, mapMenuItem, normalizeI18n, parseImages } from '../utils/mappers.js'
import {
  normalizeAvailability,
  normalizeAgeRange,
  normalizeAttributes,
  normalizeCurrency,
  normalizeImages,
  normalizeOriginalPrice,
  normalizeStock,
  normalizeVariants,
  validateItem,
  normalizeFocus,
} from '../utils/menuNormalize.js'
import { imageVersion, sendImage } from '../utils/imageResponse.js'

/**
 * All handlers derive the merchant from `req.merchantId` (set by requireAuth)
 * and scope every query to it, so a merchant can only read/modify their own
 * categories and items — passing someone else's id is impossible.
 */

// Whether products.availability has been migrated in yet. Cached per process so
// writes can include it when present and skip it when not (no crash pre-
// migration); a server restart after the migration refreshes this.
let availabilityColumn
async function hasAvailabilityColumn() {
  if (availabilityColumn === undefined) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'availability'`,
    )
    availabilityColumn = rows[0].n > 0
  }
  return availabilityColumn
}

// Same guard for products.attributes (extra unpriced option groups).
let attributesColumn
async function hasAttributesColumn() {
  if (attributesColumn === undefined) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'attributes'`,
    )
    attributesColumn = rows[0].n > 0
  }
  return attributesColumn
}

// Same guard for products.original_price (discount "was" price).
let originalPriceColumn
async function hasOriginalPriceColumn() {
  if (originalPriceColumn === undefined) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'original_price'`,
    )
    originalPriceColumn = rows[0].n > 0
  }
  return originalPriceColumn
}

// Same guard for products.currency (IQD/USD per product).
let currencyColumn
async function hasCurrencyColumn() {
  if (currencyColumn === undefined) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'currency'`,
    )
    currencyColumn = rows[0].n > 0
  }
  return currencyColumn
}

// Same guard for the per-language menu columns (products.name_i18n /
// description_i18n, categories.name_i18n). Probing products.name_i18n is enough:
// db:add-menu-translations adds all three together.
let translationColumns
async function hasTranslationColumns() {
  if (translationColumns === undefined) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'name_i18n'`,
    )
    translationColumns = rows[0].n > 0
  }
  return translationColumns
}

// Same guard for products.age_min / products.age_max (suitable age range).
let ageRangeColumn
async function hasAgeRangeColumn() {
  if (ageRangeColumn === undefined) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'age_min'`,
    )
    ageRangeColumn = rows[0].n > 0
  }
  return ageRangeColumn
}

// Same guard for products.cover_focus (where the cover sits in a card).
let coverFocusColumn
async function hasCoverFocusColumn() {
  if (coverFocusColumn === undefined) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'cover_focus'`,
    )
    coverFocusColumn = rows[0].n > 0
  }
  return coverFocusColumn
}

const merchantProductImageUrl = (productId, index, updatedAt) =>
  `/api/merchant/menu/items/${productId}/image/${index}?v=${imageVersion(updatedAt)}`

let menuListColumns
async function listMenuProductColumns() {
  if (menuListColumns === undefined) {
    const [rows] = await pool.query(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'products'`,
    )
    const names = rows.map((row) => row.name)
    const usable = names.filter((name) => name !== 'images' && name !== 'image')
    const computed = [
      names.includes('image') ? 'CHAR_LENGTH(p.`image`) > 0 AS has_image' : '0 AS has_image',
      names.includes('images')
        ? 'COALESCE(JSON_LENGTH(p.`images`), 0) AS image_count'
        : '0 AS image_count',
    ]
    menuListColumns = [...usable.map((name) => `p.\`${name}\``), ...computed].join(', ')
  }
  return menuListColumns
}

async function getMenuPage(merchantId, { limit, offset }) {
  const [categoryRows] = await pool.query(
    `SELECT c.*, COUNT(p.id) AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id AND p.merchant_id = c.merchant_id
      WHERE c.merchant_id = ?
      GROUP BY c.id
      ORDER BY c.position, c.id`,
    [merchantId],
  )
  const total = categoryRows.reduce((sum, category) => sum + Number(category.product_count ?? 0), 0)
  const products = []
  let remainingOffset = offset
  let remainingLimit = limit

  for (const category of categoryRows) {
    const productCount = Number(category.product_count ?? 0)
    if (productCount === 0) continue
    if (remainingOffset >= productCount) {
      remainingOffset -= productCount
      continue
    }
    if (remainingLimit <= 0) break

    const take = Math.min(remainingLimit, productCount - remainingOffset)
    const [rows] = await pool.query(
      `SELECT ${await listMenuProductColumns()} FROM products p
       WHERE p.merchant_id = ? AND p.category_id = ?
       ORDER BY p.position, p.id
       LIMIT ? OFFSET ?`,
      [merchantId, category.id, take, remainingOffset],
    )
    products.push(...rows)
    remainingLimit -= rows.length
    remainingOffset = 0
  }

  return {
    categories: groupMenu(categoryRows, products, undefined, {
      imageUrl: merchantProductImageUrl,
    }),
    page: {
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    },
  }
}

// GET /api/merchant/menu
export async function getMyMenu(req, res, next) {
  try {
    const wantsPage = req.query.limit !== undefined || req.query.offset !== undefined
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10))
    const offset = Math.max(0, Number(req.query.offset) || 0)
    if (wantsPage) {
      return res.json(await getMenuPage(req.merchantId, { limit, offset }))
    }

    const [categories] = await pool.query(
      'SELECT * FROM categories WHERE merchant_id = ? ORDER BY position, id',
      [req.merchantId],
    )
    const [products] = await pool.query(
      `SELECT * FROM products
        WHERE merchant_id = ?
        ORDER BY category_id, position, id`,
      [req.merchantId],
    )
    // Deliberately NO req.lang here.
    //
    // mapMenuItem resolves `name` through pickI18n, so passing the caller's
    // language would hand the merchant's own editor the translated text. The
    // edit form seeds its Name field from `name` and saves it back to the
    // `name` column — the required fallback — so an Arabic-UI merchant editing
    // any item would overwrite the original with its Arabic translation and
    // lose it permanently.
    //
    // The admin panel always shows what the merchant typed. Only public
    // storefront reads resolve translations. The per-language values still
    // travel on nameI18n / descriptionI18n for the editor to populate.
    const menu = groupMenu(categories, products)
    res.json(menu)
  } catch (err) {
    next(err)
  }
}

// GET /api/merchant/menu/items/:id
export async function getItem(req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM products WHERE id = ? AND merchant_id = ?',
      [req.params.id, req.merchantId],
    )
    if (!rows.length) {
      return res.status(404).json({ status: 'error', error: 'Item not found' })
    }
    res.json(mapMenuItem(rows[0]))
  } catch (err) {
    next(err)
  }
}

// GET /api/merchant/menu/items/:id/image/:index
export async function getItemImage(req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT image, images FROM products WHERE id = ? AND merchant_id = ?',
      [req.params.id, req.merchantId],
    )
    if (!rows.length) {
      return res.status(404).json({ status: 'error', error: 'Image not found' })
    }
    const index = Number(req.params.index) || 0
    const gallery = parseImages(rows[0].images)
    const stored = gallery[index] ?? (index === 0 ? rows[0].image : null)
    return sendImage(res, stored)
  } catch (err) {
    next(err)
  }
}

// POST /api/merchant/menu/categories  { name, nameI18n? }
export async function createCategory(req, res, next) {
  try {
    const { name, nameI18n } = req.body ?? {}
    if (!name || !name.trim()) {
      return res.status(400).json({ status: 'error', error: 'Category name is required' })
    }
    const translations = normalizeI18n(nameI18n)

    const [[{ nextPos }]] = await pool.query(
      'SELECT COALESCE(MAX(position) + 1, 0) AS nextPos FROM categories WHERE merchant_id = ?',
      [req.merchantId],
    )
    const columns = ['merchant_id', 'name', 'position']
    const values = [req.merchantId, name.trim(), nextPos]
    if (await hasTranslationColumns()) {
      columns.push('name_i18n')
      values.push(translations ? JSON.stringify(translations) : null)
    }
    const [result] = await pool.query(
      `INSERT INTO categories (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      values,
    )
    // nameI18n is echoed because useMenu.addCategory pushes this object straight
    // into state: without it, re-opening the edit modal on a category just
    // created would show empty translation fields until a full reload.
    res.status(201).json({
      id: result.insertId,
      name: name.trim(),
      nameI18n: translations ?? {},
      items: [],
    })
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/menu/categories/:id  { name, nameI18n? }
export async function updateCategory(req, res, next) {
  try {
    const { name, nameI18n } = req.body ?? {}
    if (!name || !name.trim()) {
      return res.status(400).json({ status: 'error', error: 'Category name is required' })
    }
    const translations = normalizeI18n(nameI18n)

    // Ownership check baked into the WHERE clause.
    const [existing] = await pool.query(
      'SELECT id FROM categories WHERE id = ? AND merchant_id = ?',
      [req.params.id, req.merchantId],
    )
    if (!existing.length) {
      return res.status(404).json({ status: 'error', error: 'Category not found' })
    }

    const sets = ['name = ?']
    const values = [name.trim()]
    if (await hasTranslationColumns()) {
      sets.push('name_i18n = ?')
      values.push(translations ? JSON.stringify(translations) : null)
    }
    values.push(req.params.id, req.merchantId)
    await pool.query(
      `UPDATE categories SET ${sets.join(', ')} WHERE id = ? AND merchant_id = ?`,
      values,
    )
    res.json({
      id: Number(req.params.id),
      name: name.trim(),
      nameI18n: translations ?? {},
    })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/merchant/menu/categories/:id
export async function deleteCategory(req, res, next) {
  try {
    const [result] = await pool.query(
      'DELETE FROM categories WHERE id = ? AND merchant_id = ?',
      [req.params.id, req.merchantId],
    )
    if (!result.affectedRows) {
      return res.status(404).json({ status: 'error', error: 'Category not found' })
    }
    res.json({ id: Number(req.params.id), deleted: true })
  } catch (err) {
    next(err)
  }
}

// POST /api/merchant/menu/items  { categoryId, name, description, price, image }
export async function createItem(req, res, next) {
  try {
    const {
      categoryId, name, description, price, image,
      variants: rawVariants, optionName, brand, stock: rawStock, images: rawImages,
      availability: rawAvailability, attributes: rawAttributes, originalPrice: rawOriginalPrice,
      currency: rawCurrency,
      ageMin: rawAgeMin, ageMax: rawAgeMax,
      nameI18n: rawNameI18n, descriptionI18n: rawDescriptionI18n,
    } = req.body ?? {}
    if (!categoryId) {
      return res.status(400).json({ status: 'error', error: 'categoryId is required' })
    }
    const availability = normalizeAvailability(rawAvailability)
    const currency = normalizeCurrency(rawCurrency)
    const attributes = normalizeAttributes(rawAttributes)
    const originalPrice = normalizeOriginalPrice(rawOriginalPrice)
    const ageRange = normalizeAgeRange(rawAgeMin, rawAgeMax)
    const { variants, error: variantsError } = normalizeVariants(rawVariants)
    if (variantsError) return res.status(400).json({ status: 'error', error: variantsError })
    const { stock, error: stockError } = normalizeStock(rawStock)
    if (stockError) return res.status(400).json({ status: 'error', error: stockError })
    const invalid = validateItem({ name, price, variants })
    if (invalid) return res.status(400).json({ status: 'error', error: invalid })
    const images = normalizeImages(rawImages)
    // The gallery's first image is the cover; keep `image` in sync so existing
    // single-image reads (storefront card, admin) still work.
    const cover = images[0] ?? image ?? null

    // The category must belong to THIS merchant.
    const [cat] = await pool.query(
      'SELECT id FROM categories WHERE id = ? AND merchant_id = ?',
      [categoryId, req.merchantId],
    )
    if (!cat.length) {
      return res.status(404).json({ status: 'error', error: 'Category not found' })
    }

    const [[{ nextPos }]] = await pool.query(
      'SELECT COALESCE(MAX(position) + 1, 0) AS nextPos FROM products WHERE category_id = ?',
      [categoryId],
    )
    const columns = [
      'merchant_id', 'category_id', 'name', 'description', 'price', 'option_name',
      'variants', 'brand', 'stock', 'images', 'image', 'position',
    ]
    const values = [
      req.merchantId,
      categoryId,
      name.trim(),
      description?.trim() || null,
      variants.length ? Math.min(...variants.map((variant) => variant.price)) : Number(price),
      variants.length ? (optionName?.trim() || 'Size') : null,
      variants.length ? JSON.stringify(variants) : null,
      brand?.trim() || null,
      stock,
      images.length ? JSON.stringify(images) : null,
      cover,
      nextPos,
    ]
    // Include availability only if the column exists (pre-migration safe).
    if (await hasAvailabilityColumn()) {
      columns.push('availability')
      values.push(availability)
    }
    if (await hasAttributesColumn()) {
      columns.push('attributes')
      values.push(attributes.length ? JSON.stringify(attributes) : null)
    }
    if (await hasOriginalPriceColumn()) {
      columns.push('original_price')
      values.push(originalPrice)
    }
    if (await hasCurrencyColumn()) {
      columns.push('currency')
      values.push(currency)
    }
    if (await hasAgeRangeColumn()) {
      columns.push('age_min', 'age_max')
      values.push(ageRange.min, ageRange.max)
    }
    if (await hasCoverFocusColumn()) {
      columns.push('cover_focus')
      values.push(cover ? normalizeFocus(req.body?.coverFocus) : null)
    }
    if (await hasTranslationColumns()) {
      const nameI18n = normalizeI18n(rawNameI18n)
      const descriptionI18n = normalizeI18n(rawDescriptionI18n)
      columns.push('name_i18n', 'description_i18n')
      values.push(
        nameI18n ? JSON.stringify(nameI18n) : null,
        descriptionI18n ? JSON.stringify(descriptionI18n) : null,
      )
    }
    const [result] = await pool.query(
      `INSERT INTO products (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
      values,
    )
    const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [
      result.insertId,
    ])
    // No req.lang — see getMyMenu. This response repopulates the editor.
    res.status(201).json(mapMenuItem(rows[0]))
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/menu/items/:id  { name, description, price, image }
export async function updateItem(req, res, next) {
  try {
    const {
      name, description, price, image,
      variants: rawVariants, optionName, brand, stock: rawStock, images: rawImages,
      availability: rawAvailability, attributes: rawAttributes, originalPrice: rawOriginalPrice,
      currency: rawCurrency,
      ageMin: rawAgeMin, ageMax: rawAgeMax,
      nameI18n: rawNameI18n, descriptionI18n: rawDescriptionI18n,
    } = req.body ?? {}
    const { variants, error: variantsError } = normalizeVariants(rawVariants)
    if (variantsError) return res.status(400).json({ status: 'error', error: variantsError })
    const { stock, error: stockError } = normalizeStock(rawStock)
    if (stockError) return res.status(400).json({ status: 'error', error: stockError })
    const invalid = validateItem({ name, price, variants })
    if (invalid) return res.status(400).json({ status: 'error', error: invalid })
    const images = normalizeImages(rawImages)
    const cover = images[0] ?? image ?? null
    const availability = normalizeAvailability(rawAvailability)
    const currency = normalizeCurrency(rawCurrency)
    const attributes = normalizeAttributes(rawAttributes)
    const originalPrice = normalizeOriginalPrice(rawOriginalPrice)
    const ageRange = normalizeAgeRange(rawAgeMin, rawAgeMax)

    const [existing] = await pool.query(
      'SELECT id FROM products WHERE id = ? AND merchant_id = ?',
      [req.params.id, req.merchantId],
    )
    if (!existing.length) {
      return res.status(404).json({ status: 'error', error: 'Item not found' })
    }

    const sets = [
      'name = ?', 'description = ?', 'price = ?', 'option_name = ?',
      'variants = ?', 'brand = ?', 'stock = ?', 'images = ?', 'image = ?',
    ]
    const values = [
      name.trim(),
      description?.trim() || null,
      variants.length ? Math.min(...variants.map((variant) => variant.price)) : Number(price),
      variants.length ? (optionName?.trim() || 'Size') : null,
      variants.length ? JSON.stringify(variants) : null,
      brand?.trim() || null,
      stock,
      images.length ? JSON.stringify(images) : null,
      cover,
    ]
    if (await hasAvailabilityColumn()) {
      sets.push('availability = ?')
      values.push(availability)
    }
    if (await hasAttributesColumn()) {
      sets.push('attributes = ?')
      values.push(attributes.length ? JSON.stringify(attributes) : null)
    }
    if (await hasOriginalPriceColumn()) {
      sets.push('original_price = ?')
      values.push(originalPrice)
    }
    if (await hasCurrencyColumn()) {
      sets.push('currency = ?')
      values.push(currency)
    }
    if (await hasAgeRangeColumn()) {
      sets.push('age_min = ?', 'age_max = ?')
      values.push(ageRange.min, ageRange.max)
    }
    // Only when sent: a save that doesn't mention the framing keeps it.
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'coverFocus') && (await hasCoverFocusColumn())) {
      sets.push('cover_focus = ?')
      values.push(cover ? normalizeFocus(req.body.coverFocus) : null)
    }
    if (await hasTranslationColumns()) {
      const nameI18n = normalizeI18n(rawNameI18n)
      const descriptionI18n = normalizeI18n(rawDescriptionI18n)
      sets.push('name_i18n = ?', 'description_i18n = ?')
      values.push(
        nameI18n ? JSON.stringify(nameI18n) : null,
        descriptionI18n ? JSON.stringify(descriptionI18n) : null,
      )
    }
    values.push(req.params.id, req.merchantId)
    await pool.query(
      `UPDATE products SET ${sets.join(', ')} WHERE id = ? AND merchant_id = ?`,
      values,
    )
    const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [
      req.params.id,
    ])
    // No req.lang — see getMyMenu. useMenu.editItem replaces the item in state
    // with exactly this object, which then seeds the edit form next time.
    res.json(mapMenuItem(rows[0]))
  } catch (err) {
    next(err)
  }
}

// DELETE /api/merchant/menu/items/:id
export async function deleteItem(req, res, next) {
  try {
    const [result] = await pool.query(
      'DELETE FROM products WHERE id = ? AND merchant_id = ?',
      [req.params.id, req.merchantId],
    )
    if (!result.affectedRows) {
      return res.status(404).json({ status: 'error', error: 'Item not found' })
    }
    res.json({ id: Number(req.params.id), deleted: true })
  } catch (err) {
    next(err)
  }
}
