import 'dotenv/config'
import pool from '../src/config/db.js'
import { slugForMerchant } from '../src/utils/slug.js'

/**
 * Adds merchants.slug — kept for a deliberate, logged migration of an existing
 * install. The API now performs the same steps on every boot
 * (src/db/ensureSchema.js), so a fresh deploy needs nothing run by hand.
 *
 * Adds merchants.slug — the readable part of a storefront URL, so a menu lives
 * at /r/mamo instead of /r/7.
 *
 * Backfills every existing merchant from its business name, falling back to
 * merchant-<id> when the name has no URL-usable characters. Numeric /r/:id
 * links keep working (the public controller resolves either), so nothing that
 * is already printed on a QR code breaks.
 *
 *   npm run db:add-slug
 */
const NAME = 'add-slug'

async function main() {
  const conn = await pool.getConnection()
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS applied_migrations (
        name       VARCHAR(190) NOT NULL,
        applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (name)
      ) ENGINE=InnoDB`)

    const [done] = await conn.query(
      'SELECT applied_at FROM applied_migrations WHERE name = ?',
      [NAME],
    )
    if (done.length) {
      console.log(`Already applied on ${done[0].applied_at.toISOString()} — nothing to do.`)
      return
    }

    const [existing] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = 'slug'`,
    )
    if (existing[0].n > 0) {
      console.log('• merchants.slug already present — skipped')
    } else {
      // Added without the UNIQUE key: the backfill below has to run first,
      // otherwise every existing row would collide on NULL-vs-value ordering
      // on some MySQL versions.
      await conn.query('ALTER TABLE merchants ADD COLUMN slug VARCHAR(80) NULL AFTER business_name')
      console.log('✔ merchants.slug added')
    }

    // --- backfill ---
    const [rows] = await conn.query(
      'SELECT id, business_name, slug FROM merchants ORDER BY id',
    )
    const isTaken = async (candidate, excludeId) => {
      const [hit] = await conn.query(
        'SELECT id FROM merchants WHERE slug = ? AND id <> ? LIMIT 1',
        [candidate, excludeId ?? 0],
      )
      return hit.length > 0
    }

    let filled = 0
    for (const row of rows) {
      if (row.slug) continue
      // Same rule as create time and the boot backfill (src/db/ensureSchema.js),
      // so a slug never depends on which of the three assigned it.
      const slug = await slugForMerchant(row.business_name, row.id, isTaken)
      await conn.query('UPDATE merchants SET slug = ? WHERE id = ?', [slug, row.id])
      console.log(`  ${row.id}: ${row.business_name} → /r/${slug}`)
      filled += 1
    }
    console.log(`✔ Backfilled ${filled} merchant(s)`)

    // Unique only now that every row holds a distinct value. NULL stays allowed
    // (MySQL permits repeated NULLs in a unique index) so a merchant created by
    // an older build without a slug doesn't break the constraint.
    const [idx] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'merchants' AND index_name = 'uq_merchants_slug'`,
    )
    if (idx[0].n > 0) {
      console.log('• uq_merchants_slug already present — skipped')
    } else {
      await conn.query('ALTER TABLE merchants ADD UNIQUE KEY uq_merchants_slug (slug)')
      console.log('✔ uq_merchants_slug added')
    }

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Storefronts are now reachable by name; /r/<id> still works.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
