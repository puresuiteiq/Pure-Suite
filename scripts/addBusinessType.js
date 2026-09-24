import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Adds merchants.business_type — the vertical each tenant belongs to
 * ('restaurant' | 'store').
 *
 * The platform began restaurant-only; this is what lets it also serve retail
 * (electronic stores). It drives interface wording (Menu vs Catalog) and which
 * product fields apply (a store gets brand/stock, a restaurant does not).
 *
 * Additive and safe: existing merchants default to 'restaurant', so every
 * current tenant keeps behaving exactly as before.
 *
 *   npm run db:add-business-type
 */
const NAME = 'add-business-type'

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

    console.log('Adding merchant business type:')
    await addColumn(
      conn,
      'merchants',
      'business_type',
      "VARCHAR(60) NOT NULL DEFAULT 'restaurant' AFTER business_name",
    )

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Every existing merchant is a restaurant until changed.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
