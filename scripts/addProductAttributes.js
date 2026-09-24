import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Adds products.attributes — extra unpriced option groups a product offers
 * alongside its priced variants (e.g. a shirt with Color variants AND Size
 * S/M/L/XL). JSON array of { name, values: [string] }; NULL for products with
 * none, so every existing product is unchanged.
 *
 *   npm run db:add-product-attributes
 */
const NAME = 'add-product-attributes'

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

    console.log('Adding product option attributes:')
    await addColumn(conn, 'products', 'attributes', 'JSON NULL')

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Products can now offer extra option groups (e.g. Size) alongside variants.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
