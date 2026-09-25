import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pool from '../config/db.js'
import { JWT_SECRET } from '../config/auth.js'
import { setAuthCookie, MERCHANT_COOKIE } from '../utils/cookies.js'
import { parseVariants, parseImages } from '../utils/mappers.js'
import { validateSlug, slugForMerchant } from '../utils/slug.js'
import { missingColumnMessage } from '../utils/dbErrors.js'
import { imageVersion, sendImage } from '../utils/imageResponse.js'
import { suspendExpiredSubscriptions, enforceMerchantSubscription } from '../services/subscriptions.js'

/** Human-typeable temporary password (URL-safe, ~12 chars). */
function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url')
}

/**
 * Map a DB row (snake_case columns) to the shape the frontend expects
 * (camelCase, matching the old mock merchant object).
 */
function rowToMerchant(row) {
  return {
    id: row.id,
    name: row.business_name,
    // Storefront URL segment (/r/<slug>). Never null on a database the API
    // has booted against — see ensureSchema — but older rows may predate it.
    slug: row.slug ?? null,
    businessType: row.business_type ?? 'restaurant',
    owner: row.owner_name ?? '',
    email: row.email ?? '',
    phone: row.phone ?? '',
    logo: row.logo ?? null,
    isOpen: Boolean(row.is_open),
    plan: row.plan,
    branches: row.branches,
    status: row.status,
    // YYYY-MM-DD or null (column may not be migrated yet).
    subscriptionExpiresAt: row.subscription_expires_at
      ? new Date(row.subscription_expires_at).toISOString().slice(0, 10)
      : null,
    subscriptionStartsAt: row.subscription_starts_at
      ? new Date(row.subscription_starts_at).toISOString().slice(0, 10)
      : null,
    joinedAt: row.created_at
      ? new Date(row.created_at).toISOString().slice(0, 10)
      : null,
  }
}

const adminProductImageUrl = (merchantId) => (productId, index, updatedAt) =>
  `/api/merchants/${encodeURIComponent(merchantId)}/products/${productId}/image/${index}` +
  `?v=${imageVersion(updatedAt)}`

let detailProductColumns = null
async function listDetailProductColumns() {
  if (detailProductColumns === null) {
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
    detailProductColumns = [...usable.map((name) => `p.\`${name}\``), ...computed].join(', ')
  }
  return detailProductColumns
}

function rowToDetailProduct(product, { imageUrl = null } = {}) {
  const hasImage = Boolean(product.has_image) || Number(product.image_count) > 0
  return {
    id: product.id,
    name: product.name,
    description: product.description ?? '',
    price: Number(product.price),
    currency: String(product.currency ?? '').toUpperCase() === 'USD' ? 'USD' : 'IQD',
    availability: product.availability ?? 'available',
    optionName: product.option_name ?? null,
    variants: parseVariants(product.variants),
    brand: product.brand ?? null,
    stock: product.stock == null ? null : Number(product.stock),
    image: imageUrl && hasImage
      ? imageUrl(product.id, 0, product.updated_at)
      : (product.image ?? parseImages(product.images)[0] ?? null),
  }
}

function groupDetailProducts(products, options = {}) {
  const categories = []
  const byId = new Map()
  for (const product of products) {
    const categoryId = product.category_id
    if (!byId.has(categoryId)) {
      const category = {
        id: categoryId,
        name: product.category_name,
        items: [],
      }
      byId.set(categoryId, category)
      categories.push(category)
    }
    byId.get(categoryId).items.push(rowToDetailProduct(product, options))
  }
  return categories
}

async function getMerchantMenuPage(merchantId, { limit, offset }) {
  const [categoryRows] = await pool.query(
    `SELECT c.id, c.name, c.position, COUNT(p.id) AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id AND p.merchant_id = c.merchant_id
      WHERE c.merchant_id = ?
      GROUP BY c.id, c.name, c.position
      ORDER BY c.position, c.id`,
    [merchantId],
  )
  const total = categoryRows.reduce((sum, category) => sum + Number(category.product_count ?? 0), 0)
  const productColumns = await listDetailProductColumns()
  const categories = []
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
    const [products] = await pool.query(
      `SELECT ${productColumns}, ? AS category_name, ? AS category_position
         FROM products p
        WHERE p.merchant_id = ? AND p.category_id = ?
        ORDER BY p.position, p.id
        LIMIT ? OFFSET ?`,
      [category.name, category.position, merchantId, category.id, take, remainingOffset],
    )
    categories.push(...groupDetailProducts(products, { imageUrl: adminProductImageUrl(merchantId) }))
    remainingLimit -= products.length
    remainingOffset = 0
  }

  return {
    categories,
    menuPage: {
      total,
      categoryTotal: categoryRows.length,
      limit,
      offset,
      hasMore: offset + limit < total,
    },
  }
}

function subscriptionStatusClause(status) {
  switch (status) {
    case 'active':
      return 'subscription_expires_at > DATE_ADD(CURDATE(), INTERVAL 7 DAY)'
    case 'expiring':
      return 'subscription_expires_at BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)'
    case 'expired':
      return 'subscription_expires_at < CURDATE()'
    case 'none':
      return 'subscription_expires_at IS NULL'
    default:
      return ''
  }
}

async function subscriptionSummary() {
  if (!(await merchantsHasColumn('subscription_expires_at'))) {
    return { active: 0, expiring: 0, expired: 0, none: 0 }
  }
  const [rows] = await pool.query(
    `SELECT
       SUM(CASE WHEN subscription_expires_at > DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN subscription_expires_at BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS expiring,
       SUM(CASE WHEN subscription_expires_at < CURDATE() THEN 1 ELSE 0 END) AS expired,
       SUM(CASE WHEN subscription_expires_at IS NULL THEN 1 ELSE 0 END) AS none
     FROM merchants`,
  )
  const row = rows[0] ?? {}
  return {
    active: Number(row.active ?? 0),
    expiring: Number(row.expiring ?? 0),
    expired: Number(row.expired ?? 0),
    none: Number(row.none ?? 0),
  }
}

// GET /api/merchants
export async function listMerchants(req, res, next) {
  try {
    await suspendExpiredSubscriptions()
    const wantsPage = req.query.limit !== undefined || req.query.offset !== undefined
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10))
    const offset = Math.max(0, Number(req.query.offset) || 0)
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : ''
    const subscriptionStatus =
      typeof req.query.subscriptionStatus === 'string' ? req.query.subscriptionStatus : ''
    const includeSubscriptionSummary = req.query.includeSubscriptionSummary === '1'
    const where = []
    const values = []
    if (q) {
      where.push(
        `(business_name LIKE ? OR owner_name LIKE ? OR email LIKE ? OR phone LIKE ?
          OR plan LIKE ? OR status LIKE ?)`,
      )
      const like = `%${q}%`
      values.push(like, like, like, like, like, like)
    }
    const subClause = subscriptionStatusClause(subscriptionStatus)
    if (subClause) where.push(subClause)
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    const orderSql =
      req.query.sort === 'subscription'
        ? `ORDER BY
            subscription_expires_at IS NULL,
            subscription_expires_at ASC,
            created_at DESC,
            id DESC`
        : 'ORDER BY created_at DESC, id DESC'

    if (wantsPage) {
      const [countResult, rowsResult, summaryResult] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS total FROM merchants${whereSql}`, values),
        pool.query(
          `SELECT * FROM merchants${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
          [...values, limit, offset],
        ),
        includeSubscriptionSummary ? subscriptionSummary() : Promise.resolve(null),
      ])
      const countRow = countResult[0]
      const rows = rowsResult[0]
      const total = Number(countRow[0]?.total ?? 0)
      return res.json({
        items: rows.map(rowToMerchant),
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
        ...(summaryResult ? { subscriptionSummary: summaryResult } : {}),
      })
    }

    const [rows] = await pool.query(
      `SELECT * FROM merchants${whereSql} ${orderSql}`,
      values,
    )
    res.json(rows.map(rowToMerchant))
  } catch (err) {
    next(err)
  }
}

// GET /api/merchants/:id
export async function getMerchant(req, res, next) {
  try {
    const includeMenu = req.query.menu !== '0'
    const wantsMenuPage = req.query.menuLimit !== undefined || req.query.menuOffset !== undefined
    const menuLimit = Math.max(1, Math.min(50, Number(req.query.menuLimit) || 10))
    const menuOffset = Math.max(0, Number(req.query.menuOffset) || 0)
    const [rows] = await pool.query('SELECT * FROM merchants WHERE id = ?', [
      req.params.id,
    ])
    if (!rows.length) {
      return res.status(404).json({ status: 'error', error: 'Merchant not found' })
    }
    const merchant = await enforceMerchantSubscription(rows[0])
    let categories
    let menuPage = null
    if (!includeMenu) {
      const [[categoryCount], [productCount]] = await Promise.all([
        pool.query('SELECT COUNT(*) AS total FROM categories WHERE merchant_id = ?', [
          merchant.id,
        ]),
        pool.query('SELECT COUNT(*) AS total FROM products WHERE merchant_id = ?', [
          merchant.id,
        ]),
      ])
      const total = Number(productCount[0]?.total ?? 0)
      categories = []
      menuPage = {
        total,
        categoryTotal: Number(categoryCount[0]?.total ?? 0),
        limit: menuLimit,
        offset: 0,
        hasMore: total > 0,
      }
    } else if (wantsMenuPage) {
      const page = await getMerchantMenuPage(merchant.id, {
        limit: menuLimit,
        offset: menuOffset,
      })
      categories = page.categories
      menuPage = page.menuPage
    } else {
      const [categoryRows] = await pool.query(
        'SELECT id, name, position FROM categories WHERE merchant_id = ? ORDER BY position, id',
        [merchant.id],
      )
      const [products] = await pool.query(
        // SELECT * so a not-yet-migrated column (availability) doesn't break this.
        `SELECT * FROM products WHERE merchant_id = ? ORDER BY position, id`,
        [merchant.id],
      )
      categories = categoryRows.map((category) => ({
        id: category.id,
        name: category.name,
        items: products
          .filter((product) => product.category_id === category.id)
          .map(rowToDetailProduct),
      }))
    }

    // The Super Admin may inspect tenant content, but never receives a
    // password hash or any other credential secret.
    res.json({
      merchant: {
        ...rowToMerchant(merchant),
        address: merchant.address ?? '',
    description: merchant.description ?? '',
        logo: merchant.logo ?? null,
        isOpen: Boolean(merchant.is_open),
        workingHours: merchant.working_hours ?? null,
      },
      categories,
      ...(menuPage ? { menuPage } : {}),
    })
  } catch (err) {
    next(err)
  }
}

// GET /api/merchants/:id/products/:productId/image/:index
export async function getMerchantProductImage(req, res, next) {
  try {
    const [merchantRows] = await pool.query('SELECT id FROM merchants WHERE id = ?', [req.params.id])
    if (!merchantRows.length) {
      return res.status(404).json({ status: 'error', error: 'Image not found' })
    }
    const [rows] = await pool.query(
      'SELECT image, images FROM products WHERE id = ? AND merchant_id = ?',
      [req.params.productId, req.params.id],
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

// POST /api/merchants
export async function createMerchant(req, res, next) {
  try {
    const {
      name, owner, email, phone, plan, branches, status, businessType, slug,
      subscriptionExpiresAt, subscriptionStartsAt, copyMenuFromMerchantId,
    } = req.body ?? {}

    // Coerced rather than trusted: a JSON body may hold a number (or anything
    // else) where a string is expected, and calling .trim() on it threw a
    // TypeError that surfaced as an unexplained 500.
    const businessName = text(name)
    const emailAddress = text(email)

    if (!businessName) {
      return res
        .status(400)
        .json({ status: 'error', error: 'Business name is required' })
    }
    const { value: normalizedType, error: typeError } = normalizeBusinessType(businessType)
    if (typeError) return res.status(400).json({ status: 'error', error: typeError })
    // Email is the merchant's login identifier, so it's required to create a
    // usable account.
    if (!emailAddress) {
      return res
        .status(400)
        .json({ status: 'error', error: 'Email is required (used for merchant login)' })
    }

    // status is an ENUM, and so is plan on installs predating db:widen-plan.
    // An unstorable value has to be caught here — MySQL would otherwise reject
    // the INSERT and the admin would just see "Internal server error".
    const planCheck = await validatePlan(plan || 'Starter')
    if (planCheck.error) {
      return res
        .status(planCheck.status ?? 400)
        .json({ status: 'error', error: planCheck.error })
    }
    if (status && !STATUSES.includes(status)) {
      return res.status(400).json({
        status: 'error',
        error: `status must be one of: ${STATUSES.join(', ')}`,
      })
    }

    // Generate + hash an initial password so the created account can log in
    // immediately. The plaintext is returned ONCE for the admin to share.
    const tempPassword = generateTempPassword()
    const passwordHash = await bcrypt.hash(tempPassword, 10)

    const columns = [
      'business_name', 'owner_name', 'email', 'phone', 'plan', 'branches', 'status',
    ]
    const values = [
      businessName,
      text(owner) || null,
      emailAddress,
      text(phone) || null,
      planCheck.value,
      Number(branches) || 1,
      status || 'active',
    ]
    // business_type and password_hash arrived in later migrations, so write
    // them only where they exist — the same guard the subscription columns use.
    if (await merchantsHasColumn('business_type')) {
      columns.push('business_type')
      values.push(normalizedType || 'restaurant')
    } else if (businessType !== undefined) {
      warnDropped('business_type')
    }
    const canStorePassword = await merchantsHasColumn('password_hash')
    if (canStorePassword) {
      columns.push('password_hash')
      values.push(passwordHash)
    }
    // Storefront slug. An admin-typed one is honoured exactly or refused (so
    // they are never silently given a different link). A generated one needs
    // the merchant id (Arabic names fall back to m<id>), which only exists
    // after the INSERT — assignGeneratedSlug fills it in below.
    const typedSlug = slug !== undefined && String(slug).trim() !== '' ? String(slug) : null
    const canStoreSlug = await merchantsHasColumn('slug')
    if (typedSlug && !canStoreSlug) {
      // Storing the merchant while dropping the link the admin typed is the
      // failure this whole path exists to prevent: it returns 200 and looks
      // saved. Refuse instead, and say which migration fixes it.
      return res.status(409).json({ status: 'error', error: missingColumnMessage('slug') })
    }
    if (typedSlug) {
      const check = validateSlug(typedSlug)
      if (check.error) {
        return res.status(400).json({ status: 'error', error: check.error })
      }
      if (await slugTaken(check.value, null)) {
        return res.status(409).json({
          status: 'error',
          error: `The storefront link "${check.value}" is already used by another merchant`,
        })
      }
      columns.push('slug')
      values.push(check.value)
    }
    // Include the expiry/start only if those columns have been migrated in.
    if (subscriptionExpiresAt !== undefined) {
      if (await merchantsHasColumn('subscription_expires_at')) {
        columns.push('subscription_expires_at')
        values.push(normalizeDate(subscriptionExpiresAt))
      } else {
        warnDropped('subscription_expires_at')
      }
    }
    if (subscriptionStartsAt !== undefined) {
      if (await merchantsHasColumn('subscription_starts_at')) {
        columns.push('subscription_starts_at')
        values.push(normalizeDate(subscriptionStartsAt))
      } else {
        warnDropped('subscription_starts_at')
      }
    }
    // Last: satisfy anything this database marks NOT NULL that the form above
    // never collected, so a stricter-than-schema install can still create a
    // merchant. See completeMerchantWrite.
    await completeMerchantWrite(columns, values, { addMissing: true })

    const [result] = await pool.query(
      `INSERT INTO merchants (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      values,
    )

    if (canStoreSlug && !typedSlug) {
      await assignGeneratedSlug(result.insertId, businessName)
    }

    if (copyMenuFromMerchantId) {
      await copyMerchantMenu(Number(copyMenuFromMerchantId), result.insertId)
    }

    const [rows] = await pool.query('SELECT * FROM merchants WHERE id = ?', [
      result.insertId,
    ])
    // tempPassword is included only on this create response, never stored/read
    // back — and only when there was a password_hash column to store it in.
    res.status(201).json({
      ...rowToMerchant(rows[0]),
      ...(canStorePassword ? { tempPassword } : {}),
    })
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res
        .status(409)
        .json({ status: 'error', error: duplicateMerchantMessage(err) })
    }
    next(err)
  }
}

function jsonValue(value) {
  if (value == null) return null
  return typeof value === 'object' ? JSON.stringify(value) : value
}

async function copyMerchantMenu(sourceMerchantId, targetMerchantId) {
  if (!Number.isInteger(sourceMerchantId) || sourceMerchantId <= 0) return
  if (sourceMerchantId === Number(targetMerchantId)) return

  const [source] = await pool.query('SELECT id FROM merchants WHERE id = ?', [
    sourceMerchantId,
  ])
  if (!source.length) return

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [categories] = await conn.query(
      'SELECT * FROM categories WHERE merchant_id = ? ORDER BY position, id',
      [sourceMerchantId],
    )
    const categoryMap = new Map()

    for (const category of categories) {
      const columns = ['merchant_id', 'name', 'position']
      const values = [targetMerchantId, category.name, category.position ?? 0]
      if (Object.prototype.hasOwnProperty.call(category, 'name_i18n')) {
        columns.push('name_i18n')
        values.push(jsonValue(category.name_i18n))
      }
      const [inserted] = await conn.query(
        `INSERT INTO categories (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        values,
      )
      categoryMap.set(Number(category.id), inserted.insertId)
    }

    const [products] = await conn.query(
      'SELECT * FROM products WHERE merchant_id = ? ORDER BY position, id',
      [sourceMerchantId],
    )
    const optionalColumns = [
      'name_i18n',
      'description',
      'description_i18n',
      'price',
      'currency',
      'original_price',
      'option_name',
      'variants',
      'attributes',
      'age_min',
      'age_max',
      'brand',
      'stock',
      'images',
      'image',
      'is_available',
      'availability',
      'position',
    ]

    for (const product of products) {
      const newCategoryId = categoryMap.get(Number(product.category_id))
      if (!newCategoryId) continue
      const columns = ['merchant_id', 'category_id', 'name']
      const values = [targetMerchantId, newCategoryId, product.name]
      for (const column of optionalColumns) {
        if (!Object.prototype.hasOwnProperty.call(product, column)) continue
        columns.push(column)
        values.push(jsonValue(product[column]))
      }
      await conn.query(
        `INSERT INTO products (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        values,
      )
    }

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

const STATUSES = ['active', 'trial', 'suspended']

/**
 * Give a freshly created merchant the same slug the boot backfill would have
 * given it (name-derived, m<id> for a name with no Latin characters). Runs
 * after the INSERT because both fallbacks need the assigned id.
 *
 * A failure here is logged, not raised: the merchant exists and /r/<id> works,
 * so losing the readable link is not worth failing a create the admin has
 * already been told succeeded.
 */
async function assignGeneratedSlug(id, businessName) {
  // Two merchants with the same name created at once both compute the same
  // slug and race for it; the loser retries, which now sees the winner's row
  // and moves on to the id-suffixed form.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const chosen = await slugForMerchant(businessName, id, slugTaken)
      await pool.query('UPDATE merchants SET slug = ? WHERE id = ?', [chosen, id])
      return
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' && attempt === 0) continue
      console.warn(
        `[merchants] could not assign a storefront link to merchant ${id} ` +
          `(/r/${id} still works, and the next restart fills this in): ` +
          `${err.sqlMessage || err.message}`,
      )
      return
    }
  }
}

/**
 * A value the caller explicitly supplied that this database has nowhere to put.
 * Skipping it and returning 200 is what let the missing slug column go
 * unnoticed for so long, so every drop is named in the log along with the fix.
 */
function warnDropped(column) {
  console.warn(`[merchants] ${missingColumnMessage(column)}`)
}

/** Is this storefront slug already used by a different merchant? */
async function slugTaken(candidate, excludeId) {
  const [rows] = await pool.query(
    'SELECT id FROM merchants WHERE slug = ? AND id <> ? LIMIT 1',
    [candidate, excludeId ?? 0],
  )
  return rows.length > 0
}

/** YYYY-MM-DD (or null). Anything unparseable → null. */
function normalizeDate(value) {
  if (!value) return null
  const s = String(value).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

// Cached per-process metadata for the whole merchants table, so a write can
// include a column when present, skip it otherwise, adapt to its actual type,
// and fill anything this install requires but the app has no value for (see
// completeMerchantWrite). One query rather than one per column, because every
// write needs the same picture of the table.
let merchantSchemaPromise = null
function loadMerchantSchema() {
  if (!merchantSchemaPromise) {
    merchantSchemaPromise = pool
      .query(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
           FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'merchants'`,
      )
      .then(([rows]) => {
        const columns = new Map()
        for (const row of rows) {
          const extra = String(row.EXTRA ?? '')
          columns.set(String(row.COLUMN_NAME).toLowerCase(), {
            exists: true,
            name: String(row.COLUMN_NAME),
            dataType: String(row.DATA_TYPE).toLowerCase(),
            columnType: String(row.COLUMN_TYPE),
            nullable: String(row.IS_NULLABLE).toUpperCase() === 'YES',
            // A CURRENT_TIMESTAMP default reports COLUMN_DEFAULT plus
            // DEFAULT_GENERATED; either form means MySQL fills the column.
            hasDefault: row.COLUMN_DEFAULT !== null || /DEFAULT_GENERATED/i.test(extra),
            // Values the database computes; writing to them is an error.
            generated: /auto_increment|(VIRTUAL|STORED) GENERATED/i.test(extra),
          })
        }
        return columns
      })
      .catch((err) => {
        // Never cache a failed probe — one transient outage would otherwise
        // poison every write for the life of the process.
        merchantSchemaPromise = null
        throw err
      })
  }
  return merchantSchemaPromise
}

// Stand-in for a column this database doesn't have, so callers can ask about
// any column without a null check.
const NO_COLUMN = {
  exists: false,
  name: null,
  dataType: null,
  columnType: null,
  nullable: true,
  hasDefault: true,
  generated: false,
}

async function merchantsColumn(col) {
  return (await loadMerchantSchema()).get(col.toLowerCase()) ?? NO_COLUMN
}

async function merchantsHasColumn(col) {
  return (await merchantsColumn(col)).exists
}

/**
 * A harmless value for a NOT NULL column we were never given anything to put
 * in — an empty string, a zero, today's date, matched to the column's type.
 */
function blankFor(info) {
  const allowed = enumValues(info)
  if (allowed) return allowed[0]
  switch (info.dataType) {
    case 'tinyint':
    case 'smallint':
    case 'mediumint':
    case 'int':
    case 'bigint':
    case 'decimal':
    case 'float':
    case 'double':
    case 'bit':
      return 0
    case 'year':
      return new Date().getFullYear()
    case 'date':
      return new Date().toISOString().slice(0, 10)
    case 'datetime':
    case 'timestamp':
      return new Date().toISOString().slice(0, 19).replace('T', ' ')
    case 'time':
      return '00:00:00'
    case 'json':
      return '{}'
    default:
      return ''
  }
}

/**
 * Make a write the database will actually accept.
 *
 * MySQL refuses a NOT NULL column two ways — an explicit NULL
 * (ER_BAD_NULL_ERROR) and, on INSERT, an omitted column with no DEFAULT
 * (ER_NO_DEFAULT_FOR_FIELD) — and both reached the admin as an opaque
 * "Internal server error". They fire on installs whose merchants table is
 * stricter than db/schema.sql: a hand-added column, or an older ALTER that
 * dropped a default. Neither field is one this form asks about, so a blank is
 * the honest value; failing the whole create over it is not.
 *
 * `columns`/`values` are mutated in place and stay index-aligned.
 * `addMissing` is false for UPDATE, which must only touch the fields it was
 * asked to change.
 */
async function completeMerchantWrite(columns, values, { addMissing }) {
  const schema = await loadMerchantSchema()

  for (let i = 0; i < columns.length; i += 1) {
    if (values[i] !== null) continue
    const info = schema.get(columns[i].toLowerCase())
    if (info && !info.nullable) values[i] = blankFor(info)
  }
  if (!addMissing) return

  const written = new Set(columns.map((col) => col.toLowerCase()))
  for (const [key, info] of schema) {
    if (written.has(key) || info.nullable || info.hasDefault || info.generated) continue
    columns.push(info.name)
    values.push(blankFor(info))
  }
}

/**
 * Name the field a duplicate-key error actually collided on. Both email and
 * slug are UNIQUE, so blaming email for every collision sent the admin to
 * correct a field that was never the problem.
 */
function duplicateMerchantMessage(err) {
  const key = /for key '([^']+)'/i.exec(err.sqlMessage || err.message || '')?.[1] ?? ''
  if (/slug/i.test(key)) {
    return 'That storefront link is already used by another merchant'
  }
  if (/email/i.test(key)) {
    return 'A merchant with this email already exists'
  }
  return key
    ? `Another merchant already uses that value (unique index "${key}")`
    : 'Another merchant already uses one of these values'
}

/** Trimmed string form of a submitted field — '' when absent or not a string. */
function text(value) {
  return value == null ? '' : String(value).trim()
}

/** The permitted values of an ENUM column, or null when it isn't an ENUM. */
function enumValues(info) {
  if (!info?.exists || info.dataType !== 'enum') return null
  // COLUMN_TYPE looks like: enum('a','b') — quotes inside a value are doubled.
  return [...info.columnType.matchAll(/'((?:[^']|'')*)'/g)].map((m) =>
    m[1].replace(/''/g, "'"),
  )
}

/**
 * Validate a plan name and confirm merchants.plan can actually store it.
 *
 * Plans are admin-designed rows in `plans` (name VARCHAR(80)), but an install
 * created from the older schema still has merchants.plan as
 * ENUM('Starter','Growth','Enterprise'). Assigning any other plan there makes
 * MySQL reject the write with a truncation error, which would otherwise reach
 * the user as an opaque 500 — so check the column up front and say what to do.
 */
async function validatePlan(raw) {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name || name.length > 80) return { error: 'A valid plan is required' }
  const allowed = enumValues(await merchantsColumn('plan'))
  if (allowed && !allowed.includes(name)) {
    return {
      status: 409,
      error:
        `This database still stores the plan as a fixed list (${allowed.join(', ')}), ` +
        `so the "${name}" plan cannot be assigned. Run "npm run db:widen-plan" in ` +
        'backend/ and restart the API to allow admin-designed plans.',
    }
  }
  return { value: name }
}

// Business type is a free-form category (a predefined key like 'electronics' or
// a custom name the admin types), so it's validated by shape, not a fixed list.
function normalizeBusinessType(value) {
  if (value == null) return { value: undefined, error: null }
  const trimmed = String(value).trim()
  if (!trimmed) return { value: undefined, error: 'Business type cannot be empty' }
  if (trimmed.length > 60) return { value: null, error: 'Business type is too long (max 60 characters)' }
  return { value: trimmed, error: null }
}

// PATCH /api/merchants/:id
// Partial update. Backs both Activate/Deactivate (body { status }) and the
// full Edit Merchant form (body { name, owner, email, phone, plan, status }).
export async function updateMerchant(req, res, next) {
  try {
    const body = req.body ?? {}
    const has = (f) => Object.prototype.hasOwnProperty.call(body, f)

    const assignments = []
    const columns = [] // same order as `values`, for completeMerchantWrite
    const values = []
    const setCol = (col, val) => {
      assignments.push(`${col} = ?`)
      columns.push(col)
      values.push(val)
    }

    if (has('name')) {
      if (!text(body.name)) {
        return res
          .status(400)
          .json({ status: 'error', error: 'Business name is required' })
      }
      setCol('business_name', text(body.name))
    }
    if (has('owner')) setCol('owner_name', text(body.owner) || null)
    if (has('email')) {
      if (!text(body.email)) {
        return res.status(400).json({ status: 'error', error: 'Email is required' })
      }
      setCol('email', text(body.email))
    }
    if (has('phone')) setCol('phone', text(body.phone) || null)
    if (has('slug')) {
      if (!(await merchantsHasColumn('slug'))) {
        return res.status(409).json({ status: 'error', error: missingColumnMessage('slug') })
      }
      const check = validateSlug(body.slug)
      if (check.error) {
        return res.status(400).json({ status: 'error', error: check.error })
      }
      if (await slugTaken(check.value, req.params.id)) {
        return res.status(409).json({
          status: 'error',
          error: `The storefront link "${check.value}" is already used by another merchant`,
        })
      }
      setCol('slug', check.value)
    }
    if (has('businessType')) {
      const { value, error } = normalizeBusinessType(body.businessType)
      if (error) return res.status(400).json({ status: 'error', error })
      setCol('business_type', value)
    }
    if (has('plan')) {
      // Plans are designed by the admin (dynamic), so accept any non-empty name
      // (≤80) that the plan column can actually store — see validatePlan.
      const planCheck = await validatePlan(body.plan)
      if (planCheck.error) {
        return res
          .status(planCheck.status ?? 400)
          .json({ status: 'error', error: planCheck.error })
      }
      setCol('plan', planCheck.value)
    }
    if (has('status')) {
      if (!STATUSES.includes(body.status)) {
        return res.status(400).json({
          status: 'error',
          error: `status must be one of: ${STATUSES.join(', ')}`,
        })
      }
      setCol('status', body.status)
    }
    if (has('subscriptionExpiresAt')) {
      if (await merchantsHasColumn('subscription_expires_at')) {
        setCol('subscription_expires_at', normalizeDate(body.subscriptionExpiresAt))
      } else {
        warnDropped('subscription_expires_at')
      }
    }
    if (has('subscriptionStartsAt')) {
      if (await merchantsHasColumn('subscription_starts_at')) {
        setCol('subscription_starts_at', normalizeDate(body.subscriptionStartsAt))
      } else {
        warnDropped('subscription_starts_at')
      }
    }

    if (!assignments.length) {
      return res.status(400).json({ status: 'error', error: 'No fields to update' })
    }

    const [existing] = await pool.query('SELECT id FROM merchants WHERE id = ?', [
      req.params.id,
    ])
    if (!existing.length) {
      return res.status(404).json({ status: 'error', error: 'Merchant not found' })
    }

    // A NULL aimed at a column this install marks NOT NULL is blanked rather
    // than rejected; nothing is added, an edit only touches what it was given.
    await completeMerchantWrite(columns, values, { addMissing: false })

    values.push(req.params.id)
    await pool.query(
      `UPDATE merchants SET ${assignments.join(', ')} WHERE id = ?`,
      values,
    )

    const [rows] = await pool.query('SELECT * FROM merchants WHERE id = ?', [
      req.params.id,
    ])
    res.json(rowToMerchant(rows[0]))
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res
        .status(409)
        .json({ status: 'error', error: duplicateMerchantMessage(err) })
    }
    next(err)
  }
}

// DELETE /api/merchants/:id
export async function deleteMerchant(req, res, next) {
  try {
    const [result] = await pool.query('DELETE FROM merchants WHERE id = ?', [
      req.params.id,
    ])
    if (!result.affectedRows) {
      return res.status(404).json({ status: 'error', error: 'Merchant not found' })
    }
    // Return a JSON body (not 204) so the frontend's apiClient can parse it.
    res.json({ id: Number(req.params.id), deleted: true })
  } catch (err) {
    next(err)
  }
}

// POST /api/merchants/:id/reset-password
// Passwords are intentionally one-way hashes, so an administrator cannot read
// an existing password. This generates a fresh one-time credential instead.
export async function resetMerchantPassword(req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT id, email FROM merchants WHERE id = ?',
      [req.params.id],
    )
    if (!rows.length) {
      return res.status(404).json({ status: 'error', error: 'Merchant not found' })
    }

    const tempPassword = generateTempPassword()
    const passwordHash = await bcrypt.hash(tempPassword, 10)
    await pool.query('UPDATE merchants SET password_hash = ? WHERE id = ?', [
      passwordHash,
      req.params.id,
    ])
    res.json({ email: rows[0].email, tempPassword })
  } catch (err) {
    next(err)
  }
}

// POST /api/merchants/:id/impersonate
// Lets a Super Admin "open" a merchant's account and manage it from the real
// merchant panel. It mints a merchant session cookie for the target merchant
// WITHOUT clearing the admin cookie (unlike login), so both sessions coexist —
// the admin can edit everything as that merchant and then exit back to admin.
// The `impersonatedBy` claim is the audit trail; the token is short-lived.
export async function impersonateMerchant(req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT id, email, business_name, status FROM merchants WHERE id = ?',
      [req.params.id],
    )
    if (!rows.length) {
      return res.status(404).json({ status: 'error', error: 'Merchant not found' })
    }
    const merchant = rows[0]
    // A suspended merchant is blocked by requireAuth on every /api/merchant/*
    // call, so an impersonation token for one would be useless — refuse clearly.
    if (merchant.status === 'suspended') {
      return res.status(409).json({
        status: 'error',
        error: 'Reactivate this merchant before managing its account.',
      })
    }

    const token = jwt.sign(
      {
        merchantId: merchant.id,
        email: merchant.email,
        role: 'merchant',
        impersonatedBy: req.admin.id,
      },
      JWT_SECRET,
      { expiresIn: '2h' },
    )
    // Set the merchant cookie; do NOT clear the admin cookie (the whole point).
    setAuthCookie(res, MERCHANT_COOKIE, token)

    // eslint-disable-next-line no-console
    console.log(`[impersonate] admin ${req.admin.id} → merchant ${merchant.id}`)

    res.json({
      merchantId: merchant.id,
      email: merchant.email,
      businessName: merchant.business_name,
    })
  } catch (err) {
    next(err)
  }
}

// POST /api/merchants/:id/renew  { date? }  (legacy: { days? })
// Sets the merchant's new subscription expiry date directly — `date`
// ('YYYY-MM-DD') is what the calendar picker in the UI sends. `days` is kept
// as a fallback for any older caller: extends by that many days (or the
// plan's billing period, else 30) from whichever is later, today or the
// current expiry.
export async function renewMerchant(req, res, next) {
  try {
    if (!(await merchantsHasColumn('subscription_expires_at'))) {
      return res.status(409).json({
        status: 'error',
        error: 'Subscription tracking is not enabled yet (run db:add-subscription-expiry).',
      })
    }
    const [rows] = await pool.query(
      'SELECT id, plan, subscription_expires_at FROM merchants WHERE id = ?',
      [req.params.id],
    )
    if (!rows.length) return res.status(404).json({ status: 'error', error: 'Merchant not found' })
    const m = rows[0]

    let newExpiry = normalizeDate(req.body?.date)
    if (!newExpiry) {
      const requestedDays = Number(req.body?.days)
      let periodDays
      if (Number.isInteger(requestedDays) && requestedDays > 0) {
        // Cap well beyond any sane billing period so a stray huge number
        // can't push the expiry into an unusable date.
        periodDays = Math.min(requestedDays, 3650)
      } else {
        // No/invalid custom length — fall back to the plan's billing period, else 30.
        periodDays = 30
        try {
          const [[plan]] = await pool.query(
            'SELECT period_days FROM plans WHERE name = ? LIMIT 1',
            [m.plan],
          )
          if (plan?.period_days) periodDays = Number(plan.period_days)
        } catch {
          // plans table not migrated — fall back to 30.
        }
      }

      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const current = m.subscription_expires_at ? new Date(m.subscription_expires_at) : today
      const base = current > today ? current : today
      base.setDate(base.getDate() + periodDays)
      newExpiry = base.toISOString().slice(0, 10)
    }

    await pool.query('UPDATE merchants SET subscription_expires_at = ?, status = ? WHERE id = ?', [
      newExpiry,
      'active',
      req.params.id,
    ])
    res.json({ subscriptionExpiresAt: newExpiry, status: 'active' })
  } catch (err) {
    next(err)
  }
}

// POST /api/merchants/:id/cancel-subscription
// Ends the subscription by setting the expiry to yesterday, so it reads as
// "Expired" immediately everywhere the expiry date is shown — clearer than
// clearing the date back to unset, which would look like no subscription had
// ever existed rather than one that was cancelled.
export async function cancelSubscription(req, res, next) {
  try {
    if (!(await merchantsHasColumn('subscription_expires_at'))) {
      return res.status(409).json({
        status: 'error',
        error: 'Subscription tracking is not enabled yet (run db:add-subscription-expiry).',
      })
    }
    const [existing] = await pool.query('SELECT id FROM merchants WHERE id = ?', [
      req.params.id,
    ])
    if (!existing.length) {
      return res.status(404).json({ status: 'error', error: 'Merchant not found' })
    }

    const yesterday = new Date()
    yesterday.setHours(0, 0, 0, 0)
    yesterday.setDate(yesterday.getDate() - 1)
    const expiresAt = yesterday.toISOString().slice(0, 10)

    await pool.query('UPDATE merchants SET subscription_expires_at = ?, status = ? WHERE id = ?', [
      expiresAt,
      'suspended',
      req.params.id,
    ])
    res.json({ subscriptionExpiresAt: expiresAt, status: 'suspended' })
  } catch (err) {
    next(err)
  }
}
