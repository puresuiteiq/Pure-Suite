import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Adds order service methods + per-zone delivery fees:
 *   - merchants.service_methods JSON — which methods the merchant offers and its
 *     delivery zones/fees.
 *   - orders.service_method / delivery_zone / delivery_fee / table_number — what
 *     the customer chose at checkout, stored per order.
 * All NULL by default, so existing merchants/orders are unchanged and the
 * storefront checkout only shows the picker once a merchant configures methods.
 *
 *   npm run db:add-service-methods
 */
const NAME = 'add-service-methods'

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

    console.log('Adding service methods + delivery fees:')
    await addColumn(conn, 'merchants', 'service_methods', 'JSON NULL')
    await addColumn(conn, 'orders', 'service_method', 'VARCHAR(20) NULL')
    await addColumn(conn, 'orders', 'delivery_zone', 'VARCHAR(120) NULL')
    await addColumn(conn, 'orders', 'delivery_fee', 'DECIMAL(10,2) NULL')
    await addColumn(conn, 'orders', 'table_number', 'VARCHAR(20) NULL')

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Merchants can now offer delivery / dine-in / pickup with zone fees.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
