import pool from '../config/db.js'
import { slugForMerchant } from '../utils/slug.js'
import { describeDbError } from '../utils/dbErrors.js'

/**
 * Schema steps that run on every boot, before the server accepts requests.
 *
 * The db:* scripts in package.json remain the way to migrate deliberately;
 * this exists because a hosted deployment (Railway) has no step where anyone
 * runs them, and the failure mode is silent: with no merchants.slug column
 * every write that touches it is skipped, the Super Admin's "Storefront Link"
 * saves to nothing and still returns 200, and QR codes quietly fall back to
 * /r/<id>. A boot-time check costs one query and removes that whole class of
 * "the feature is deployed but does nothing".
 *
 * Every step must be idempotent and safe to run against a database that is
 * already correct — it runs on every restart, not once.
 */
const TAG = '[schema]'

/**
 * Each step runs on its own: one that fails (a database user without ALTER or
 * CREATE rights, say) is reported, and the steps after it still run.
 */
const STEPS = [
  ['merchants.slug', ensureMerchantSlug],
  ['merchant_banners', ensureMerchantBanners],
  ['merchant_splash_media', ensureMerchantSplash],
  ['merchants.storefront_theme', ensureStorefrontTheme],
  ['merchants.map_url', ensureMerchantMapUrl],
  ['products.currency', ensureProductCurrency],
  ['daily order numbers', ensureDailyOrderNumbers],
  ['listing indexes', ensureListingIndexes],
]

export async function ensureSchema() {
  let conn
  try {
    conn = await pool.getConnection()
    for (const [name, step] of STEPS) {
      try {
        await step(conn)
      } catch (err) {
        report(`could not prepare ${name}`, err)
      }
    }
  } catch (err) {
    // Never block startup on this. A database that is unreachable at boot
    // (common on a platform that starts the app and its database together)
    // must not turn into a container that refuses to serve anything — and a
    // step that genuinely fails is reported by every affected write anyway,
    // through the same messages describeDbError produces.
    report('could not verify the schema', err)
  } finally {
    conn?.release()
  }
}

function report(what, err) {
  const described = describeDbError(err)
  console.error(
    `${TAG} ${what} — the API is starting anyway. ` + (described?.error ?? err?.message ?? err),
  )
}

/**
 * The merchant_banners table and merchants.show_banner, behind the Banners
 * page of the merchant panel. `npm run db:add-banners` calls this same function.
 *
 * Done at boot for the reason this file exists: without it a hosted deploy
 * ships the Banners page with nowhere to store an upload. The storefront never
 * depended on it — banner reads check for the table and fall back to the
 * carousel built from product photos.
 */
export async function ensureMerchantBanners(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS merchant_banners (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      merchant_id BIGINT UNSIGNED NOT NULL,
      image       MEDIUMTEXT      NOT NULL,
      title       VARCHAR(120)    NULL,
      link_type   ENUM('none','product','category') NOT NULL DEFAULT 'none',
      link_id     BIGINT UNSIGNED NULL,
      position    INT UNSIGNED    NOT NULL DEFAULT 0,
      is_active   BOOLEAN         NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                                  ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_merchant_banners_merchant (merchant_id, position),
      CONSTRAINT fk_merchant_banners_merchant
        FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  // Checked first rather than "ADD COLUMN IF NOT EXISTS", for the same MySQL /
  // MariaDB portability reason as merchants.slug above.
  const [columns] = await conn.query("SHOW COLUMNS FROM merchants LIKE 'show_banner'")
  if (!columns.length) {
    await conn.query('ALTER TABLE merchants ADD COLUMN show_banner BOOLEAN NOT NULL DEFAULT TRUE')
    console.log(`${TAG} added merchants.show_banner`)
  }
  console.log(`${TAG} merchant_banners ready`)
}

/**
 * The storefront welcome screen: merchants.splash_enabled / splash_tagline,
 * the merchant_splash_media table holding its background picture or video, and
 * admins.public_contact_whatsapp for the "designed by" credit it carries.
 * `npm run db:add-splash` calls this same function.
 *
 * LONGBLOB rather than the MEDIUMTEXT data URLs used elsewhere: a video is
 * served in byte ranges, and base64 would add a third to every one of them.
 */
export async function ensureMerchantSplash(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS merchant_splash_media (
      merchant_id  BIGINT UNSIGNED NOT NULL,
      content_type VARCHAR(40)     NOT NULL,
      byte_size    INT UNSIGNED    NOT NULL,
      data         LONGBLOB        NOT NULL,
      updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (merchant_id),
      CONSTRAINT fk_merchant_splash_media_merchant
        FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  // Checked first rather than "ADD COLUMN IF NOT EXISTS", for the same MySQL /
  // MariaDB portability reason as merchants.slug.
  const columns = [
    ['merchants', 'splash_enabled', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['merchants', 'splash_tagline', 'VARCHAR(160) NULL'],
    ['admins', 'public_contact_whatsapp', 'VARCHAR(40) NULL'],
  ]
  for (const [table, column, definition] of columns) {
    const [found] = await conn.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column])
    if (!found.length) {
      await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      console.log(`${TAG} added ${table}.${column}`)
    }
  }
  console.log(`${TAG} storefront welcome screen ready`)
}

/**
 * merchants.storefront_theme — which storefront design the merchant picked in
 * their profile. NULL reads as 'classic', the original design, so existing
 * stores look exactly as before. `npm run db:add-storefront-theme` calls this.
 */
export async function ensureStorefrontTheme(conn) {
  const [columns] = await conn.query("SHOW COLUMNS FROM merchants LIKE 'storefront_theme'")
  if (!columns.length) {
    await conn.query('ALTER TABLE merchants ADD COLUMN storefront_theme VARCHAR(20) NULL')
    console.log(`${TAG} added merchants.storefront_theme`)
  }
  console.log(`${TAG} storefront themes ready`)
}

/** merchants.map_url: optional direct map link pasted by the merchant. */
export async function ensureMerchantMapUrl(conn) {
  const [columns] = await conn.query("SHOW COLUMNS FROM merchants LIKE 'map_url'")
  if (!columns.length) {
    await conn.query('ALTER TABLE merchants ADD COLUMN map_url VARCHAR(1024) NULL AFTER address')
    console.log(`${TAG} added merchants.map_url`)
  }
  console.log(`${TAG} merchant map links ready`)
}

/** products.currency — lets a merchant price each product in IQD or USD. */
export async function ensureProductCurrency(conn) {
  const [columns] = await conn.query("SHOW COLUMNS FROM products LIKE 'currency'")
  if (!columns.length) {
    await conn.query(
      "ALTER TABLE products ADD COLUMN currency ENUM('IQD','USD') NOT NULL DEFAULT 'IQD' AFTER price",
    )
    console.log(`${TAG} added products.currency`)
  }
  console.log(`${TAG} product currencies ready`)
}

/** Visible order numbers can optionally restart each day per merchant. */
export async function ensureDailyOrderNumbers(conn) {
  const [merchantColumns] = await conn.query("SHOW COLUMNS FROM merchants LIKE 'daily_order_numbers'")
  if (!merchantColumns.length) {
    await conn.query(
      'ALTER TABLE merchants ADD COLUMN daily_order_numbers BOOLEAN NOT NULL DEFAULT FALSE AFTER show_banner',
    )
    console.log(`${TAG} added merchants.daily_order_numbers`)
  }

  const [orderColumns] = await conn.query("SHOW COLUMNS FROM orders LIKE 'order_sequence_date'")
  if (!orderColumns.length) {
    await conn.query(
      'ALTER TABLE orders ADD COLUMN order_sequence_date DATE NULL AFTER merchant_order_no',
    )
    console.log(`${TAG} added orders.order_sequence_date`)
  }

  await conn.query(
    'UPDATE orders SET order_sequence_date = DATE(created_at) WHERE merchant_order_no IS NOT NULL AND order_sequence_date IS NULL',
  )

  const [indexes] = await conn.query('SHOW INDEX FROM orders')
  const oldIndex = indexes.find((idx) => idx.Key_name === 'uq_orders_merchant_no')
  if (oldIndex) {
    await conn.query('ALTER TABLE orders DROP INDEX uq_orders_merchant_no')
    console.log(`${TAG} dropped orders.uq_orders_merchant_no`)
  }

  const newIndex = indexes.find((idx) => idx.Key_name === 'uq_orders_merchant_date_no')
  if (!newIndex) {
    await conn.query(
      'ALTER TABLE orders ADD UNIQUE KEY uq_orders_merchant_date_no (merchant_id, order_sequence_date, merchant_order_no)',
    )
    console.log(`${TAG} added orders.uq_orders_merchant_date_no`)
  }

  console.log(`${TAG} daily order numbers ready`)
}

/** Composite indexes for paginated menu/listing reads. */
export async function ensureListingIndexes(conn) {
  const indexes = [
    ['categories', 'idx_categories_merchant_order', '(merchant_id, position, id)'],
    ['products', 'idx_products_merchant_order', '(merchant_id, position, id)'],
    ['products', 'idx_products_category_order', '(category_id, position, id)'],
    ['products', 'idx_products_merchant_category_order', '(merchant_id, category_id, position, id)'],
    ['reviews', 'idx_reviews_merchant_created', '(merchant_id, created_at)'],
  ]
  for (const [table, name, columns] of indexes) {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [table, name],
    )
    if (Number(rows[0]?.n ?? 0) > 0) continue
    await conn.query(`CREATE INDEX ${name} ON ${table} ${columns}`)
    console.log(`${TAG} added ${table}.${name}`)
  }
  console.log(`${TAG} listing indexes ready`)
}

/**
 * merchants.slug + its unique index + a backfill for every row still NULL.
 *
 * Deliberately not "ADD COLUMN IF NOT EXISTS": MySQL only accepts that from
 * 8.0.29 (and MariaDB spells it differently), so the column is checked first
 * and added with plain DDL.
 */
async function ensureMerchantSlug(conn) {
  const [columns] = await conn.query("SHOW COLUMNS FROM merchants LIKE 'slug'")
  if (!columns.length) {
    await conn.query(
      'ALTER TABLE merchants ADD COLUMN slug VARCHAR(80) NULL AFTER business_name',
    )
    console.log(`${TAG} added merchants.slug`)
  }

  // Backfill before the unique index exists: a table full of NULLs is fine
  // either way, but creating the index first would reject the whole ALTER if
  // any two rows already collided.
  const filled = await backfillSlugs(conn)
  await ensureSlugIndex(conn)

  console.log(
    filled
      ? `${TAG} merchants.slug ready — backfilled ${filled} merchant(s)`
      : `${TAG} merchants.slug ready — nothing to backfill`,
  )
}

/** Give every slug-less merchant the same slug create-time would have given it. */
async function backfillSlugs(conn) {
  const [rows] = await conn.query(
    'SELECT id, business_name FROM merchants WHERE slug IS NULL ORDER BY id',
  )
  if (!rows.length) return 0

  const isTaken = async (candidate, excludeId) => {
    const [hit] = await conn.query(
      'SELECT id FROM merchants WHERE slug = ? AND id <> ? LIMIT 1',
      [candidate, excludeId ?? 0],
    )
    return hit.length > 0
  }

  let filled = 0
  for (const row of rows) {
    const slug = await slugForMerchant(row.business_name, row.id, isTaken)
    await conn.query('UPDATE merchants SET slug = ? WHERE id = ?', [slug, row.id])
    console.log(`${TAG}   ${row.id}: ${row.business_name} → /r/${slug}`)
    filled += 1
  }
  return filled
}

/**
 * A UNIQUE index on slug, unless one is already there. The name is not assumed:
 * an install that ran `npm run db:add-slug` has uq_merchants_slug, and creating
 * a second index over the same column would be pure duplication.
 */
async function ensureSlugIndex(conn) {
  const [indexes] = await conn.query('SHOW INDEX FROM merchants')
  const existing = indexes.find(
    (row) =>
      String(row.Column_name).toLowerCase() === 'slug' && Number(row.Non_unique) === 0,
  )
  if (existing) return

  try {
    await conn.query('CREATE UNIQUE INDEX idx_merchants_slug ON merchants (slug)')
    console.log(`${TAG} added unique index idx_merchants_slug`)
  } catch (err) {
    // Duplicate slugs predating this (hand-edited rows, or a half-finished
    // migration) are the one thing that can fail here. The column still works
    // without the index, so say what to fix rather than aborting the boot.
    console.error(
      `${TAG} could not add the unique index on merchants.slug — ` +
        `two merchants share a slug. Fix the duplicates and restart. (${err.code ?? err.message})`,
    )
  }
}
