import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * One-time migration: money columns held US dollars and the storefront
 * multiplied by 1300 at display time. IQD is now the system's only currency and
 * the stored number IS dinars, so the historical values are converted once here
 * and the display-time conversion is gone from the code.
 *
 * The rate matches the one the storefront always displayed, so customer-facing
 * prices are unchanged by this: a 2.00 item read "2,600 د.ع" before and after.
 *
 * Running twice would multiply prices by 1300 again, so this records itself in
 * `applied_migrations` and refuses to run a second time. The pre-migration rows
 * are copied to `*_pre_iqd` tables first.
 *
 *   npm run db:convert-iqd
 */
const RATE = 1300
const NAME = 'convert-prices-to-iqd'
const toIqd = (usd) => Math.round(Number(usd) * RATE)

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
      console.log(
        `Already applied on ${done[0].applied_at.toISOString()} — nothing to do.`,
      )
      console.log('Prices are already stored in IQD. Re-running would ×1300 again.')
      return
    }

    // Keep the dollar values recoverable.
    for (const table of ['products', 'orders', 'order_items']) {
      await conn.query(`DROP TABLE IF EXISTS ${table}_pre_iqd`)
      await conn.query(`CREATE TABLE ${table}_pre_iqd AS SELECT * FROM ${table}`)
    }
    console.log('Backed up to products_pre_iqd, orders_pre_iqd, order_items_pre_iqd.')

    await conn.beginTransaction()

    const [p] = await conn.query(`UPDATE products SET price = ROUND(price * ${RATE})`)
    const [o] = await conn.query(`UPDATE orders SET total = ROUND(total * ${RATE})`)
    const [oi] = await conn.query(
      `UPDATE order_items SET unit_price = ROUND(unit_price * ${RATE})`,
    )

    // Variant prices live inside a JSON array, so they're rewritten in JS
    // rather than SQL.
    const [rows] = await conn.query(
      'SELECT id, variants FROM products WHERE variants IS NOT NULL AND JSON_LENGTH(variants) > 0',
    )
    let variantCount = 0
    for (const row of rows) {
      const variants = typeof row.variants === 'string' ? JSON.parse(row.variants) : row.variants
      const converted = variants.map((v) => ({ ...v, price: toIqd(v.price) }))
      await conn.query('UPDATE products SET variants = ? WHERE id = ?', [
        JSON.stringify(converted),
        row.id,
      ])
      variantCount += converted.length
    }

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    await conn.commit()

    console.log(`Converted at ×${RATE}:`)
    console.log(`  products.price        ${p.changedRows} rows`)
    console.log(`  orders.total          ${o.changedRows} rows`)
    console.log(`  order_items.unit_price ${oi.changedRows} rows`)
    console.log(`  variant prices        ${variantCount} across ${rows.length} products`)
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('Migration failed, rolled back:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
