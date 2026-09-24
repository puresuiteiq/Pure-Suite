import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Adds retail product fields and generalises the variant model, so the platform
 * can serve electronic stores as well as restaurants.
 *
 * New product columns (all NULL for existing restaurant rows):
 *   - option_name  the variant group label ("Size" for restaurants; "Storage"/
 *                  "Color" for stores)
 *   - brand        manufacturer
 *   - stock        inventory (NULL = untracked, as restaurants stay)
 *   - images       gallery JSON array (the existing `image` remains the cover)
 *
 * And renames the variant JSON field `size_name` → `value`, so a variant is a
 * generic { value, price }. Existing rows are rewritten and get option_name
 * 'Size' (they were restaurant sizes).
 *
 * Additive + idempotent: restaurants keep working unchanged.
 *
 *   npm run db:add-retail-fields
 */
const NAME = 'add-retail-product-fields'

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

    console.log('Adding retail product columns:')
    await addColumn(conn, 'products', 'option_name', "VARCHAR(60) NULL AFTER price")
    await addColumn(conn, 'products', 'brand', 'VARCHAR(120) NULL AFTER variants')
    await addColumn(conn, 'products', 'stock', 'INT NULL AFTER brand')
    await addColumn(conn, 'products', 'images', 'JSON NULL AFTER stock')

    // Rewrite existing variants from { size_name, price } to { value, price },
    // and label those groups "Size" (they were restaurant sizes). Done per row
    // in JS so it works regardless of the running MySQL's JSON function support.
    const [rows] = await conn.query(
      "SELECT id, variants FROM products WHERE variants IS NOT NULL",
    )
    let rewritten = 0
    for (const row of rows) {
      let parsed
      try {
        parsed = typeof row.variants === 'string' ? JSON.parse(row.variants) : row.variants
      } catch {
        continue
      }
      if (!Array.isArray(parsed) || parsed.length === 0) continue
      // Only rewrite the old shape; leave already-migrated rows alone.
      if (!('size_name' in (parsed[0] ?? {}))) continue
      const next = parsed.map((v) => ({ value: v.size_name, price: Number(v.price) }))
      await conn.query(
        'UPDATE products SET variants = ?, option_name = COALESCE(option_name, ?) WHERE id = ?',
        [JSON.stringify(next), 'Size', row.id],
      )
      rewritten += 1
    }
    console.log(`  rewrote ${rewritten} product variant set(s) to { value, price }`)

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Restaurants keep working; the new fields stay NULL for them.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
