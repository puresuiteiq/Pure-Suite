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
