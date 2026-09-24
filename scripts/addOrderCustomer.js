import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Adds orders.customer_name / customer_phone — the customer details captured at
 * checkout, so the merchant's order history shows who placed each order (the
 * same info as the confirmation screen). Both nullable; existing orders keep
 * NULL. The order flow tolerates these columns being absent, so this migration
 * only *enables* saving/showing the details.
 *
 *   npm run db:add-order-customer
 */
const NAME = 'add-order-customer'

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

    console.log('Adding order customer columns:')
    await addColumn(conn, 'orders', 'customer_name', 'VARCHAR(150) NULL AFTER merchant_order_no')
    await addColumn(conn, 'orders', 'customer_phone', 'VARCHAR(40) NULL AFTER customer_name')

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. New orders will store the customer name + phone.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
