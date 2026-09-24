import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Adds products.availability — the merchant-set per-item availability shown on
 * the storefront: 'available', 'unavailable', or 'out_of_stock'. Defaults to
 * 'available', so every existing item stays for sale. The menu flow tolerates
 * this column being absent, so this migration only *enables* the feature.
 *
 *   npm run db:add-item-availability
 */
const NAME = 'add-item-availability'

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

    const [cols] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'availability'`,
    )
    if (cols[0].n > 0) {
      console.log('  products.availability already present — skipped')
    } else {
      await conn.query(
        `ALTER TABLE products ADD COLUMN availability
           ENUM('available','unavailable','out_of_stock')
           NOT NULL DEFAULT 'available' AFTER is_available`,
      )
      console.log('  products.availability added')
    }

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Every item defaults to available.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
