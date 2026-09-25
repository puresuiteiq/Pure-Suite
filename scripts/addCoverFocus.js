import 'dotenv/config'
import pool from '../src/config/db.js'
import { ensureCoverFocus } from '../src/db/ensureSchema.js'

const NAME = 'add-cover-focus'

/**
 * products.cover_focus — where a product's cover sits inside a storefront card.
 *
 * The API also does this on every boot (src/db/ensureSchema.js); this is the
 * by-hand route, sharing the boot step's code. Idempotent either way.
 */
async function main() {
  const conn = await pool.getConnection()
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS applied_migrations (name VARCHAR(190) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (name)) ENGINE=InnoDB`)
    await ensureCoverFocus(conn)
    await conn.query('INSERT IGNORE INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('Product cover framing is ready. Restart the API so it sees the new column.')
  } finally {
    conn.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
