import pool from '../config/db.js'
import { groupMenu, mapMenuItem, normalizeI18n } from '../utils/mappers.js'
import {
  normalizeAvailability,
  normalizeAgeRange,
  normalizeAttributes,
  normalizeImages,
  normalizeOriginalPrice,
  normalizeStock,
  normalizeVariants,
  validateItem,
} from '../utils/menuNormalize.js'

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

// GET /api/merchant/menu
export async function getMyMenu(req, res, next) {
  try {
    const [categories] = await pool.query(
      'SELECT * FROM categories WHERE merchant_id = ? ORDER BY position, id',
      [req.merchantId],
    )
    const [products] = await pool.query(
      'SELECT * FROM products WHERE merchant_id = ? ORDER BY position, id',
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
    res.json(groupMenu(categories, products))
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
      ageMin: rawAgeMin, ageMax: rawAgeMax,
      nameI18n: rawNameI18n, descriptionI18n: rawDescriptionI18n,
    } = req.body ?? {}
    if (!categoryId) {
      return res.status(400).json({ status: 'error', error: 'categoryId is required' })
    }
    const availability = normalizeAvailability(rawAvailability)
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
    if (await hasAgeRangeColumn()) {
      columns.push('age_min', 'age_max')
      values.push(ageRange.min, ageRange.max)
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
    if (await hasAgeRangeColumn()) {
      sets.push('age_min = ?', 'age_max = ?')
      values.push(ageRange.min, ageRange.max)
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
