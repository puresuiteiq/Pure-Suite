import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Composite indexes for the queries a storefront runs on every visit.
 *
 * Each one filters by merchant and then sorts. The existing single-column
 * indexes satisfy the filter but not the sort, so MySQL reads the matching rows
 * and then sorts them — fine for one merchant with five products, increasingly
 * not fine as a platform fills up, because the cost lands on the request every
 * customer waits for.
 *
 *   categories  WHERE merchant_id = ? ORDER BY position, id
 *   products    WHERE merchant_id = ? ORDER BY position, id
 *   reviews     WHERE merchant_id = ? ORDER BY created_at DESC, id DESC
 *
 * A covering composite lets the index supply the order directly. The older
 * single-column indexes are left in place: they still serve other queries, and
 * dropping indexes on a live database is not something a convenience script
 * should do behind an operator's back.
 *
 *   npm run db:add-list-indexes
 */
const NAME = 'add-list-indexes'

const INDEXES = [
  { table: 'categories', name: 'idx_categories_merchant_order', columns: '(merchant_id, position, id)' },
  { table: 'products', name: 'idx_products_merchant_order', columns: '(merchant_id, position, id)' },
  { table: 'products', name: 'idx_products_category_order', columns: '(category_id, position, id)' },
  { table: 'products', name: 'idx_products_merchant_category_order', columns: '(merchant_id, category_id, position, id)' },
  { table: 'reviews', name: 'idx_reviews_merchant_created', columns: '(merchant_id, created_at)' },
]

async function addIndex(conn, { table, name, columns }) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, name],
  )
  if (rows[0].n > 0) {
    console.log(`  ${table}.${name} already present — skipped`)
    return
  }
  await conn.query(`CREATE INDEX ${name} ON ${table} ${columns}`)
  console.log(`  ${table}.${name} added`)
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

    const [done] = await conn.query('SELECT applied_at FROM applied_migrations WHERE name = ?', [
      NAME,
    ])
    if (done.length) {
      console.log(`Already applied on ${done[0].applied_at.toISOString()} — nothing to do.`)
      return
    }

    console.log('Adding composite indexes for storefront listings:')
    for (const index of INDEXES) await addIndex(conn, index)

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Menu and review listings no longer sort after filtering.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
