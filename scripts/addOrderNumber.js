import pool from '../src/config/db.js'

/**
 * Adds orders.merchant_order_no — the per-merchant order number the customer
 * and restaurant both reference (each merchant's #1, #2, …), separate from the
 * global auto-increment `id`.
 *
 * Idempotent, like the sibling db:add-* scripts: each step is guarded so a
 * re-run is a no-op. Order matters — backfill existing rows BEFORE adding the
 * unique key, so the index validates against real, non-colliding data.
 */
async function main() {
  // 1. Column.
  const [columns] = await pool.query(
    "SHOW COLUMNS FROM orders LIKE 'merchant_order_no'",
  )
  if (!columns.length) {
    await pool.query(
      'ALTER TABLE orders ADD COLUMN merchant_order_no BIGINT UNSIGNED NULL AFTER total',
    )
    console.log('Added orders.merchant_order_no')
  } else {
    console.log('orders.merchant_order_no already exists')
  }

  // 2. Backfill any rows still missing a number, numbering each merchant's
  //    orders by chronology (oldest = #1). ROW_NUMBER needs MySQL 8+.
  const [unnumbered] = await pool.query(
    'SELECT COUNT(*) AS c FROM orders WHERE merchant_order_no IS NULL',
  )
  if (unnumbered[0].c > 0) {
    await pool.query(`
      UPDATE orders o
      JOIN (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY merchant_id ORDER BY created_at, id
               ) AS n
        FROM orders
      ) seq ON seq.id = o.id
      SET o.merchant_order_no = seq.n
      WHERE o.merchant_order_no IS NULL`)
    console.log(`Backfilled ${unnumbered[0].c} order number(s)`)
  } else {
    console.log('No orders to backfill')
  }

  // 3. Unique key (merchant_id, merchant_order_no).
  const [indexes] = await pool.query(
    "SHOW INDEX FROM orders WHERE Key_name = 'uq_orders_merchant_no'",
  )
  if (!indexes.length) {
    await pool.query(
      'ALTER TABLE orders ADD UNIQUE KEY uq_orders_merchant_no (merchant_id, merchant_order_no)',
    )
    console.log('Added unique key uq_orders_merchant_no')
  } else {
    console.log('uq_orders_merchant_no already exists')
  }

  await pool.end()
}

main().catch(async (error) => {
  console.error(error)
  await pool.end()
  process.exit(1)
})
