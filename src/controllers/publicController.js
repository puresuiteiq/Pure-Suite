import pool from '../config/db.js'
import { appUrl } from '../config/appUrl.js'
import { resolveService } from '../utils/service.js'
import { ERROR_CODES, errorBody } from '../utils/errorCodes.js'
import { imageVersion, sendImage } from '../utils/imageResponse.js'
import { BANNER_LIST_COLUMNS, bannersAvailable } from '../db/banners.js'
import { linkTargetSets, mapBanner } from '../utils/banners.js'
import { enforceMerchantSubscription } from '../services/subscriptions.js'
import {
  groupMenu,
  mapProfile,
  mapReview,
  parseAttributes,
  parseImages,
  parseServiceMethods,
  parseVariants,
} from '../utils/mappers.js'

// GET /api/public/config
/**
 * Deployment values the browser cannot know on its own. Today that is the one
 * thing a QR code must not get wrong: the domain to print. The dashboard is
 * reachable on every hostname this deployment answers on, so building the link
 * from window.location.origin encodes whichever one the merchant happened to
 * open — a platform hostname, a preview URL — into a code that gets printed and
 * scanned for months. APP_URL is the domain the business actually owns.
 *
 * Unauthenticated on purpose: it holds nothing the storefront doesn't already
 * expose by being reachable at that address.
 */
export async function getPublicConfig(req, res) {
  let platformBranding = mapPlatformBranding()
  try {
    const [admins] = await pool.query('SELECT * FROM admins ORDER BY id ASC LIMIT 1')
    platformBranding = mapPlatformBranding(admins[0])
  } catch {
    // The app URL is still useful when the database is temporarily unreachable;
    // storefront reads will report their own database problem separately.
  }
  res.json({ appUrl: appUrl(), platformBranding })
}

// Cached per-process: a database that has not run db:add-slug has no slug
// column, and querying it would fail outright.
let hasSlugColumn = null
async function merchantsHaveSlug() {
  if (hasSlugColumn === null) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = 'slug'`,
    )
    hasSlugColumn = rows[0].n > 0
  }
  return hasSlugColumn
}

/**
 * A storefront URL carries either a slug (/r/mamo) or a merchant id (/r/7 —
 * what every link printed before slugs existed uses). Both must resolve to the
 * same store, so nothing already shared or printed on a QR code breaks.
 *
 * Returns the merchant row, or null when nothing matches.
 */
async function resolveMerchant(param) {
  const raw = String(param ?? '').trim()
  if (!raw) return null
  // A bare number is always an id — slugify() guarantees a slug is never
  // purely numeric, so the two forms can never collide.
  if (/^\d+$/.test(raw)) {
    const [rows] = await pool.query('SELECT * FROM merchants WHERE id = ?', [raw])
    return enforceMerchantSubscription(rows[0] ?? null)
  }
  if (!(await merchantsHaveSlug())) return null
  const [rows] = await pool.query('SELECT * FROM merchants WHERE slug = ?', [raw.toLowerCase()])
  return enforceMerchantSubscription(rows[0] ?? null)
}

/**
 * The product columns a storefront listing needs — everything except `images`.
 *
 * The listing sends only each product's cover, but the query still read every
 * gallery out of MySQL and threw it away. On a hosted deploy the database is a
 * separate service, so that is real bytes over the wire for data nobody asked
 * for: on the measured five-item menu, ~1.4 MB read per page view.
 *
 * Built from information_schema rather than hardcoded, because this project
 * deliberately runs against databases that are missing later columns — naming
 * them directly would turn an un-migrated install from "works" into
 * ER_BAD_FIELD_ERROR. Cached per process, like the other schema probes here.
 */
let productListColumns = null
async function listProductColumns() {
  if (productListColumns === null) {
    const [rows] = await pool.query(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'products'`,
    )
    const names = rows.map((r) => r.name)
    // Neither image column is selected. The listing returns URLs, so all it
    // needs is whether a cover exists and how many gallery entries there are —
    // both computed by the database, so the image bytes never cross the wire.
    const usable = names.filter((name) => name !== 'images' && name !== 'image')
    const computed = [
      names.includes('image') ? 'CHAR_LENGTH(`image`) > 0 AS has_image' : '0 AS has_image',
      names.includes('images')
        ? 'COALESCE(JSON_LENGTH(`images`), 0) AS image_count'
        : '0 AS image_count',
    ]
    productListColumns = usable.length
      ? [...usable.map((n) => `\`${n}\``), ...computed].join(', ')
      : '*'
  }
  return productListColumns
}

/**
 * Which optional `orders` columns this database has.
 *
 * Cached per process, like every other schema probe here. It used to run on
 * every order — and it ran *inside* the transaction, so each checkout paid a
 * round trip to information_schema while holding the row lock that serialises
 * order numbering for that merchant. On a hosted deploy the database is a
 * separate service, so that is real latency added to the one request a customer
 * waits on, and real contention for the merchant behind it.
 *
 * A migration applied while the API is running needs a restart to be seen,
 * which is already this project's documented behaviour for column shapes.
 */
let orderColumns = null
async function orderColumnSet(conn) {
  if (orderColumns === null) {
    const [rows] = await conn.query(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'orders'`,
    )
    orderColumns = new Set(rows.map((c) => c.name))
  }
  return orderColumns
}

/**
 * URLs for the image endpoints below.
 *
 * `v` is the row's updated_at. It makes each URL change whenever the merchant
 * edits that product, which is what allows the bytes to be cached for a year:
 * the cached copy can never be stale, because editing produces a different URL.
 *
 * The merchant segment is carried through exactly as the customer typed it
 * (slug or id) so the link works either way and matches the page they are on.
 */
const productImageUrl = (merchantParam) => (productId, index, updatedAt) =>
  `/api/public/merchants/${encodeURIComponent(merchantParam)}/products/${productId}/image/${index}` +
  `?v=${imageVersion(updatedAt)}`

const merchantLogoUrl = (merchantParam) => (updatedAt) =>
  `/api/public/merchants/${encodeURIComponent(merchantParam)}/logo?v=${imageVersion(updatedAt)}`

const bannerImageUrl = (merchantParam) => (bannerId, updatedAt) =>
  `/api/public/merchants/${encodeURIComponent(merchantParam)}/banners/${bannerId}/image` +
  `?v=${imageVersion(updatedAt)}`

// GET /api/public/merchants/:merchantId/products/:productId/image/:index
export async function getProductImage(req, res, next) {
  try {
    const merchant = await resolveMerchant(req.params.merchantId)
    if (!merchant || merchant.status === 'suspended') {
      return res.status(404).json({ status: 'error', error: 'Image not found' })
    }
    const [rows] = await pool.query(
      'SELECT image, images FROM products WHERE id = ? AND merchant_id = ?',
      [req.params.productId, merchant.id],
    )
    if (!rows.length) {
      return res.status(404).json({ status: 'error', error: 'Image not found' })
    }

    const index = Number(req.params.index) || 0
    const gallery = parseImages(rows[0].images)
    // Index 0 falls back to the cover, which is what a product saved before
    // galleries existed has.
    const stored = gallery[index] ?? (index === 0 ? rows[0].image : null)
    return sendImage(res, stored)
  } catch (err) {
    next(err)
  }
}

// GET /api/public/merchants/:merchantId/logo
export async function getMerchantLogo(req, res, next) {
  try {
    const merchant = await resolveMerchant(req.params.merchantId)
    if (!merchant) {
      return res.status(404).json({ status: 'error', error: 'Image not found' })
    }
    return sendImage(res, merchant.logo)
  } catch (err) {
    next(err)
  }
}

// GET /api/public/merchants/:merchantId/banners/:bannerId/image
export async function getBannerImage(req, res, next) {
  try {
    const merchant = await resolveMerchant(req.params.merchantId)
    if (!merchant || merchant.status === 'suspended' || !(await bannersAvailable())) {
      return res.status(404).json({ status: 'error', error: 'Image not found' })
    }
    // Only a banner the storefront is showing. A switched-off one is the
    // merchant's draft, not public content.
    const [rows] = await pool.query(
      'SELECT image FROM merchant_banners WHERE id = ? AND merchant_id = ? AND is_active = 1',
      [req.params.bannerId, merchant.id],
    )
    if (!rows.length) {
      return res.status(404).json({ status: 'error', error: 'Image not found' })
    }
    return sendImage(res, rows[0].image)
  } catch (err) {
    next(err)
  }
}

/**
 * The merchant's active banners, in order, with image URLs.
 *
 * A link whose product or category has since been deleted comes back as no
 * link, so a slide never opens something that isn't there — checked against
 * the menu rows this request has already loaded, not another query.
 */
async function listStorefrontBanners(merchantId, merchantParam, categories, products) {
  if (!(await bannersAvailable())) return []
  const [rows] = await pool.query(
    `SELECT ${BANNER_LIST_COLUMNS} FROM merchant_banners
     WHERE merchant_id = ? AND is_active = 1 ORDER BY position, id`,
    [merchantId],
  )
  const linkTargets = linkTargetSets(categories, products)
  const imageUrl = bannerImageUrl(merchantParam)
  return rows.map((row) => mapBanner(row, { imageUrl, linkTargets }))
}

const REVIEW_SELECT = `
  SELECT id, customer_name, rating, comment,
         DATE_FORMAT(created_at, '%Y-%m-%d') AS date
  FROM reviews`

function mapPlatformBranding(row = {}) {
  return {
    logo: row.public_brand_logo ?? null,
    poweredByText: row.public_powered_by_text ?? null,
    name: row.public_brand_name ?? null,
    poweredByColor: row.public_powered_by_color ?? null,
    nameColor: row.public_brand_name_color ?? null,
  }
}

/**
 * Unauthenticated storefront read. Returns the public-facing profile, full
 * menu and recent reviews for a merchant by id. This data is intentionally
 * public (it's what customers browse), so no token is required.
 */
// GET /api/public/merchants/:merchantId
export async function getPublicRestaurant(req, res, next) {
  try {
    // The URL segment is a slug or an id; everything below works from the
    // numeric id, so resolve once here.
    const merchant = await resolveMerchant(req.params.merchantId)
    if (!merchant) {
      return res.status(404).json(errorBody('Restaurant not found', ERROR_CODES.MERCHANT_NOT_FOUND))
    }
    const merchantId = merchant.id
    const merchants = [merchant]

    // This is platform-owned branding, not merchant-owned data. Reading the
    // first Super Admin is intentional: the platform has one global footer.
    const [admins] = await pool.query('SELECT * FROM admins ORDER BY id ASC LIMIT 1')
    const platformBranding = mapPlatformBranding(admins[0])

    // Suspended merchant: expose only branding + a suspended flag so the
    // storefront shows "temporarily unavailable" instead of the menu.
    if (merchants[0].status === 'suspended') {
      return res.json({
        suspended: true,
        profile: {
          businessName: merchants[0].business_name,
          logo: merchants[0].logo,
        },
        categories: [],
        banners: [],
        reviews: [],
        platformBranding,
      })
    }

    const [categories] = await pool.query(
      'SELECT * FROM categories WHERE merchant_id = ? ORDER BY position, id',
      [merchantId],
    )
    const [products] = await pool.query(
      `SELECT ${await listProductColumns()} FROM products
       WHERE merchant_id = ? ORDER BY position, id`,
      [merchantId],
    )
    const [reviews] = await pool.query(
      `${REVIEW_SELECT} WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
      [merchantId],
    )
    const profile = mapProfile(merchantId, merchants[0], {
      logoUrl: merchantLogoUrl(req.params.merchantId),
    })
    // Nothing to send when the merchant has switched the banner off — the
    // storefront then shows no carousel at all, not even the automatic one.
    const banners = profile.showBanner
      ? await listStorefrontBanners(merchantId, req.params.merchantId, categories, products)
      : []

    // Let the browser keep a copy and revalidate it.
    //
    // Express already sends an ETag, but with no Cache-Control a browser will
    // not store the response at all, so it never sends If-None-Match and every
    // revisit re-downloads the whole menu. `no-cache` means "reuse it, but
    // check first" — an unchanged menu then costs a 304 with an empty body
    // instead of half a megabyte, while a menu the merchant just edited still
    // appears immediately.
    //
    // `private` because a storefront response carries that merchant's own
    // content and must not be held in a shared proxy cache.
    res.set('Cache-Control', 'private, no-cache')
    res.json({
      suspended: false,
      profile,
      // Images are URLs, not data. The browser then fetches only the ones it
      // actually displays, caches each separately, and never downloads a
      // gallery for a product nobody opened.
      categories: groupMenu(categories, products, req.lang, {
        imageUrl: productImageUrl(req.params.merchantId),
      }),
      // Merchant-uploaded slides for the top carousel. Empty means the
      // storefront builds the carousel from product photos, as it always has.
      banners,
      reviews: reviews.map(mapReview),
      platformBranding,
    })
  } catch (err) {
    next(err)
  }
}

// GET /api/public/merchants/:merchantId/products/:productId/images
/**
 * One product's full image gallery, fetched when a customer opens it.
 *
 * The menu listing deliberately carries only each product's cover, because a
 * gallery nobody has asked to see is the bulk of the payload: on a five-item
 * menu the galleries were 1433 KB of a 2152 KB response, none of it rendered
 * until a product is tapped.
 *
 * Scoped to the merchant in the URL so a product id cannot be used to read
 * another store's images.
 */
export async function getProductImages(req, res, next) {
  try {
    const merchant = await resolveMerchant(req.params.merchantId)
    if (!merchant) {
      return res.status(404).json(errorBody('Restaurant not found', ERROR_CODES.MERCHANT_NOT_FOUND))
    }
    if (merchant.status === 'suspended') {
      return res.status(403).json(errorBody('Store unavailable', ERROR_CODES.STORE_UNAVAILABLE))
    }

    const [rows] = await pool.query(
      'SELECT images, image FROM products WHERE id = ? AND merchant_id = ?',
      [req.params.productId, merchant.id],
    )
    if (!rows.length) {
      return res.status(404).json({ status: 'error', error: 'Item not found' })
    }

    const images = parseImages(rows[0].images)
    // A gallery changes only when the merchant edits the product, and it is the
    // heaviest thing a customer downloads — worth revalidating rather than
    // refetching.
    res.set('Cache-Control', 'private, no-cache')
    // Fall back to the cover for products saved before galleries existed.
    res.json({ images: images.length ? images : [rows[0].image].filter(Boolean) })
  } catch (err) {
    next(err)
  }
}

/**
 * A customer leaves a review for the restaurant. Public (no auth) but
 * CSRF-protected like any state-changing request. The review is linked to the
 * merchant from the URL param.
 */
// POST /api/public/merchants/:merchantId/reviews  { customerName, rating, comment }
export async function createReview(req, res, next) {
  try {
    const { customerName, rating, comment } = req.body ?? {}

    const merchant = await resolveMerchant(req.params.merchantId)
    if (!merchant) {
      return res.status(404).json(errorBody('Restaurant not found', ERROR_CODES.MERCHANT_NOT_FOUND))
    }
    const merchantId = merchant.id
    const merchants = [merchant]
    // The merchant may have turned the rating system off. Only block when the
    // column exists and is explicitly false — if it's absent (pre-migration),
    // reviews default to on rather than rejecting everyone.
    if (merchants[0].reviews_enabled != null && !merchants[0].reviews_enabled) {
      return res
        .status(403)
        .json(errorBody('Reviews are disabled for this store', ERROR_CODES.REVIEWS_DISABLED))
    }
    if (!customerName || !customerName.trim()) {
      return res.status(400).json(errorBody('Your name is required', ERROR_CODES.REVIEW_NAME_REQUIRED))
    }
    const ratingNum = Number(rating)
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res
        .status(400)
        .json(errorBody('Rating must be between 1 and 5', ERROR_CODES.REVIEW_RATING_INVALID))
    }

    const [result] = await pool.query(
      'INSERT INTO reviews (merchant_id, customer_name, rating, comment) VALUES (?, ?, ?, ?)',
      [merchantId, customerName.trim(), ratingNum, comment?.trim() || null],
    )
    const [rows] = await pool.query(`${REVIEW_SELECT} WHERE id = ?`, [
      result.insertId,
    ])
    res.status(201).json(mapReview(rows[0]))
  } catch (err) {
    next(err)
  }
}

/**
 * A stock shortfall discovered inside the transaction.
 *
 * Thrown rather than returned: the transactional block has no early exits, so
 * the existing catch owns the rollback. Returning from inside it would leave an
 * open transaction on the connection.
 */
class OutOfStockError extends Error {
  constructor(productName, available) {
    super(`Not enough stock for ${productName}`)
    this.name = 'OutOfStockError'
    this.productName = productName
    this.available = available
  }
}

/**
 * Concurrent orders for the same merchant can derive the same
 * merchant_order_no; uq_orders_merchant_no rejects the loser. Retrying is the
 * whole point of that unique key — without it the collision surfaced to a
 * customer at checkout as a 409 about a database index.
 */
const MAX_ORDER_ATTEMPTS = 3

/**
 * Record a real order when the customer places one (clicks "Send" to WhatsApp).
 * Names and prices are resolved server-side from the merchant's own products
 * (the client only chooses ids + quantities), so totals can't be tampered with
 * and each line snapshots the name/price at order time. The order and its line
 * items are written together in a transaction. This is what makes the
 * Orders/Revenue dashboards reflect real, persisted activity.
 */
// POST /api/public/merchants/:merchantId/orders  { items:[{ id, quantity }] }
export async function createOrder(req, res, next) {
  const conn = await pool.getConnection()
  let inTransaction = false
  try {
    const { items, customerName, customerPhone } = req.body ?? {}
    const custName = customerName ? String(customerName).trim().slice(0, 150) : null
    const custPhone = customerPhone ? String(customerPhone).trim().slice(0, 40) : null

    // Resolved before the transaction opens. SELECT * so service_methods is
    // read when present without breaking pre-migration installs.
    const merchant = await resolveMerchant(req.params.merchantId)
    if (!merchant) {
      return res.status(404).json(errorBody('Restaurant not found', ERROR_CODES.MERCHANT_NOT_FOUND))
    }
    const merchantId = merchant.id
    const merchants = [merchant]
    if (merchants[0].status === 'suspended') {
      return res.status(403).json(errorBody('Store unavailable', ERROR_CODES.STORE_UNAVAILABLE))
    }
    if (!merchants[0].is_open) {
      return res.status(403).json(errorBody('Store is currently closed', ERROR_CODES.STORE_CLOSED))
    }

    // Aggregate quantities by product and selected size. This keeps each
    // variant as a distinct order line while still validating server-side.
    const requested = new Map()
    if (Array.isArray(items)) {
      for (const it of items) {
        const id = Number(it?.id)
        const qty = Math.floor(Number(it?.quantity))
        if (Number.isInteger(id) && id > 0 && qty > 0) {
          const sizeName = it?.size_name ? String(it.size_name).trim() : ''
          // Selected extra option values, e.g. { Size: 'L' }. Keyed into the
          // line so the same product in different sizes stays a distinct line.
          const attrs = it?.attributes && typeof it.attributes === 'object' ? it.attributes : {}
          const attrKey = Object.keys(attrs)
            .sort()
            .map((k) => `${k}=${String(attrs[k])}`)
            .join('|')
          const key = `${id}:${sizeName}:${attrKey}`
          const existing = requested.get(key)
          requested.set(key, {
            id,
            sizeName,
            attributes: attrs,
            quantity: (existing?.quantity ?? 0) + qty,
          })
        }
      }
    }
    if (requested.size === 0) {
      return res
        .status(400)
        .json(errorBody('Order must contain at least one item', ERROR_CODES.ORDER_EMPTY))
    }

    // Authoritative name + price from the merchant's own products.
    const ids = [...new Set([...requested.values()].map((item) => item.id))]
    const [products] = await conn.query(
      // SELECT * so an un-migrated column (availability) doesn't break ordering.
      `SELECT * FROM products
       WHERE merchant_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      [merchantId, ...ids],
    )
    if (!products.length) {
      return res
        .status(400)
        .json(errorBody('Order items are no longer available', ERROR_CODES.ORDER_ITEMS_UNAVAILABLE))
    }

    const productById = new Map(products.map((product) => [Number(product.id), product]))
    const lines = []
    for (const request of requested.values()) {
      const product = productById.get(request.id)
      if (!product) continue
      const variants = parseVariants(product.variants)
      const variant = request.sizeName
        ? variants.find((entry) => entry.value === request.sizeName)
        : null
      if (request.sizeName && !variant) {
        return res
          .status(400)
          .json(errorBody('Selected option is no longer available', ERROR_CODES.OPTION_UNAVAILABLE))
      }
      // Availability gate: the merchant may have marked this item unavailable or
      // sold out. `availability` is absent pre-migration → treated as available.
      if (product.availability && product.availability !== 'available') {
        return res.status(400).json(
          errorBody(
            `${product.name} is currently unavailable`,
            ERROR_CODES.ITEM_UNAVAILABLE,
            { name: product.name },
          ),
        )
      }
      // Early stock gate, so the common case fails fast with a clear message.
      // It is NOT the real check: it compares one line at a time against a read
      // taken before the transaction. The conditional UPDATE inside the
      // transaction is authoritative — it aggregates lines per product and
      // cannot be raced.
      if (product.stock != null && request.quantity > Number(product.stock)) {
        return res.status(400).json(
          errorBody(
            `Not enough stock for ${product.name} — only ${Number(product.stock)} left.`,
            ERROR_CODES.OUT_OF_STOCK,
            { name: product.name, available: Number(product.stock) },
          ),
        )
      }
      // Append the customer's chosen extra-option values (e.g. "· L"), keeping
      // only values that really exist on the product — the snapshot name is what
      // the merchant reads to fulfil the order.
      const groups = parseAttributes(product.attributes)
      const attrLabels = []
      for (const group of groups) {
        const chosen = request.attributes?.[group.name]
        if (chosen != null && group.values.includes(String(chosen).trim())) {
          attrLabels.push(String(chosen).trim())
        }
      }
      const baseName = variant ? `${product.name} (${variant.value})` : product.name
      lines.push({
        productId: product.id,
        name: attrLabels.length ? `${baseName} · ${attrLabels.join(' · ')}` : baseName,
        unitPrice: variant ? Number(variant.price) : Number(product.price),
        quantity: request.quantity,
      })
    }
    const itemsTotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0)
    if (!(itemsTotal > 0)) {
      return res
        .status(400)
        .json(errorBody('Order total must be greater than zero', ERROR_CODES.ORDER_TOTAL_INVALID))
    }

    // Resolve the service method + delivery fee against the merchant's own config
    // (authoritative — the client can't dictate the fee). Fee-free when unset.
    const service = resolveService(parseServiceMethods(merchants[0].service_methods), req.body)
    // A delivery zone the merchant does not offer is refused rather than
    // quietly becoming free delivery. Raised here, four lines before
    // beginTransaction, so it stays outside the transaction entirely.
    if (service.error === 'ZONE_UNAVAILABLE') {
      return res.status(400).json(
        errorBody(
          'That delivery area is not available. Please choose one from the list.',
          ERROR_CODES.ZONE_UNAVAILABLE,
        ),
      )
    }
    const deliveryFee = service.deliveryFee ?? 0
    const total = itemsTotal + deliveryFee

    // Quantities to deduct, aggregated per product.
    //
    // Aggregation matters: stock is per product, but a customer can order the
    // same product as two lines (two sizes, two colours). The pre-transaction
    // check above compares each line separately, so 3 + 3 of a 5-stock product
    // passes it. The conditional UPDATE below is the authoritative check.
    //
    // Products with NULL stock are skipped entirely — that means "not tracked",
    // which is every restaurant item. Emitting `stock >= ?` against NULL yields
    // NULL, which is falsy, so an unguarded decrement would fail every
    // restaurant order as out of stock.
    const stockToDeduct = new Map()
    for (const line of lines) {
      const product = productById.get(Number(line.productId))
      if (product?.stock == null) continue
      const id = Number(line.productId)
      stockToDeduct.set(id, (stockToDeduct.get(id) ?? 0) + line.quantity)
    }

    let orderId
    let merchantOrderNo
    for (let attempt = 1; ; attempt += 1) {
      try {
        await conn.beginTransaction()
        inTransaction = true

        // Per-merchant order number: this merchant's next in sequence. FOR
        // UPDATE locks the read so two concurrent orders can't derive the same
        // number; uq_orders_merchant_no is the backstop, and the retry below is
        // what makes that backstop recoverable instead of an error.
        const [[seq]] = await conn.query(
          `SELECT COALESCE(MAX(merchant_order_no), 0) + 1 AS next
           FROM orders WHERE merchant_id = ? FOR UPDATE`,
          [merchantId],
        )
        merchantOrderNo = Number(seq.next)

        // Deduct stock. `stock >= ?` in the WHERE makes this a check and a write
        // in one statement, so two concurrent orders cannot both pass: the
        // second matches no row and is rolled back. Reading then writing would
        // let both through.
        for (const [productId, quantity] of stockToDeduct) {
          const [deduction] = await conn.query(
            `UPDATE products SET stock = stock - ?
             WHERE id = ? AND merchant_id = ? AND stock IS NOT NULL AND stock >= ?`,
            [quantity, productId, merchantId, quantity],
          )
          if (!deduction.affectedRows) {
            const [[current]] = await conn.query(
              'SELECT name, stock FROM products WHERE id = ? AND merchant_id = ?',
              [productId, merchantId],
            )
            throw new OutOfStockError(
              current?.name ?? 'This item',
              current?.stock == null ? 0 : Number(current.stock),
            )
          }
        }

        // Build the INSERT from whichever optional columns exist (each added by
        // a later migration) — so recording an order never breaks pre-migration.
        const hasCol = await orderColumnSet(conn)
        const cols = ['merchant_id', 'merchant_order_no', 'total', 'status']
        // 'pending' — a just-placed order has not been fulfilled, and the
        // merchant needs to see which ones are new. Every dashboard aggregate
        // counts `status NOT IN ('cancelled','failed')`, so this does not change
        // any existing number: every row already recorded is 'completed'.
        const vals = [merchantId, merchantOrderNo, total, 'pending']
        const addCol = (name, value) => {
          if (hasCol.has(name)) {
            cols.push(name)
            vals.push(value)
          }
        }
        addCol('customer_name', custName)
        addCol('customer_phone', custPhone)
        addCol('service_method', service.serviceMethod)
        addCol('delivery_zone', service.deliveryZone)
        addCol('delivery_fee', service.serviceMethod ? deliveryFee : null)
        addCol('table_number', service.tableNumber)
        const [result] = await conn.query(
          `INSERT INTO orders (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          vals,
        )
        orderId = result.insertId
        // mysql2's bulk VALUES ? form takes a nested array and only works with
        // query(), not execute().
        await conn.query(
          `INSERT INTO order_items
             (order_id, product_id, product_name, quantity, unit_price)
           VALUES ?`,
          [lines.map((l) => [orderId, l.productId, l.name, l.quantity, l.unitPrice])],
        )

        await conn.commit()
        inTransaction = false
        break
      } catch (err) {
        if (inTransaction) {
          try {
            await conn.rollback()
          } catch {
            /* rollback best-effort */
          }
          inTransaction = false
        }
        // Only the order-number collision is retryable, and only a few times.
        // The rollback above undid the stock deduction too, so the next attempt
        // re-derives the number and re-checks stock against live rows.
        if (err.code === 'ER_DUP_ENTRY' && attempt < MAX_ORDER_ATTEMPTS) continue
        throw err
      }
    }

    res.status(201).json({
      id: orderId,
      merchantOrderNo,
      total,
      itemsTotal,
      deliveryFee,
      serviceMethod: service.serviceMethod,
      deliveryZone: service.deliveryZone,
      tableNumber: service.tableNumber,
    })
  } catch (err) {
    if (inTransaction) {
      try {
        await conn.rollback()
      } catch {
        /* rollback best-effort */
      }
    }
    // A stock shortfall is the customer's problem to act on, not a server
    // fault: someone else bought the last one between browsing and checkout.
    if (err instanceof OutOfStockError) {
      return res.status(400).json(
        errorBody(
          `Not enough stock for ${err.productName} — only ${err.available} left.`,
          ERROR_CODES.OUT_OF_STOCK,
          { name: err.productName, available: err.available },
        ),
      )
    }
    next(err)
  } finally {
    conn.release()
  }
}
