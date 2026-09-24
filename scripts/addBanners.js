import 'dotenv/config'
import pool from '../src/config/db.js'
import { ensureMerchantBanners } from '../src/db/ensureSchema.js'

const NAME = 'add-banners'

/**
 * Storefront banners: the merchant_banners table and merchants.show_banner.
 *
 * The API also does this on every boot (src/db/ensureSchema.js). This is the
 * deliberate, by-hand route — for a database user that can only migrate from
 * here, or to check the result — and it shares the boot step's code, so the
 * two can never disagree. Idempotent either way.
 */
async function main() {
  const conn = await pool.getConnection()
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS applied_migrations (name VARCHAR(190) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (name)) ENGINE=InnoDB`)
    await ensureMerchantBanners(conn)
    await conn.query('INSERT IGNORE INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('Storefront banners are ready. Restart the API so it sees the new table.')
  } finally {
    conn.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
