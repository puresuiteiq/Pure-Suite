import 'dotenv/config'
import pool from '../src/config/db.js'
import { ensureStorefrontTheme } from '../src/db/ensureSchema.js'

const NAME = 'add-storefront-theme'

/**
 * merchants.storefront_theme — the storefront design a merchant picks.
 *
 * The API also does this on every boot (src/db/ensureSchema.js); this is the
 * by-hand route, sharing the boot step's code. Idempotent either way.
 */
async function main() {
  const conn = await pool.getConnection()
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS applied_migrations (name VARCHAR(190) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (name)) ENGINE=InnoDB`)
    await ensureStorefrontTheme(conn)
    await conn.query('INSERT IGNORE INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('Storefront themes are ready. Restart the API so it sees the new column.')
  } finally {
    conn.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
