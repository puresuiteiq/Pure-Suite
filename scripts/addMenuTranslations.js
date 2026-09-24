import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Adds per-language names/descriptions to the menu.
 *
 * Customers browse in whatever language they picked, but a merchant types their
 * menu once — so "shawarma" stayed "shawarma" on an Arabic or Kurdish
 * storefront. i18n can't help: it translates the interface, and a product name
 * is data nobody has translated.
 *
 * Storage is JSON (`{"en": "...", "ar": "...", "ku-badini": "..."}`) rather
 * than a column per language, matching how `variants` and `working_hours`
 * already work here — a fourth language then costs no migration.
 *
 * The existing `name`/`description` columns stay as the required fallback: what
 * the merchant typed originally, shown whenever a translation is absent. So
 * this migration is additive and every existing menu keeps working untouched.
 *
 *   npm run db:add-menu-translations
 */
const NAME = 'add-menu-translations'

/** Add a column only if it isn't there — makes a partial re-run safe. */
async function addColumn(conn, table, column, definition) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  )
  if (rows[0].n > 0) {
    console.log(`  ${table}.${column} already present — skipped`)
    return false
  }
  await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  console.log(`  ${table}.${column} added`)
  return true
}

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

    console.log('Adding translation columns:')
    await addColumn(conn, 'products', 'name_i18n', 'JSON NULL AFTER name')
    await addColumn(conn, 'products', 'description_i18n', 'JSON NULL AFTER description')
    await addColumn(conn, 'categories', 'name_i18n', 'JSON NULL AFTER name')

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Existing menus are untouched — every row falls back to')
    console.log('its current name until a merchant fills a translation in.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
