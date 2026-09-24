import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Adds merchants.accent_color + merchants.accent_shadow — the two brand colours
 * a merchant picks for their storefront (the add-to-cart / "+" / checkout
 * buttons and price accents). Both NULL by default, so every existing merchant
 * keeps the storefront's green look until they choose their own colours.
 *
 *   npm run db:add-accent-color
 */
const NAME = 'add-accent-color'

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

    // No `AFTER <col>` — the referenced column may not exist yet in databases
    // where earlier migrations haven't run, and column order is cosmetic anyway.
    console.log('Adding merchant storefront brand colours:')
    await addColumn(conn, 'merchants', 'accent_color', 'VARCHAR(9) NULL')
    await addColumn(conn, 'merchants', 'accent_shadow', 'VARCHAR(9) NULL')

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Storefronts stay green until a merchant sets their own colours.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
