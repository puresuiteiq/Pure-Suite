import 'dotenv/config'
import pool from '../src/config/db.js'
import { ensureAdminRoles } from '../src/db/ensureSchema.js'

const NAME = 'add-admin-roles'

/**
 * Sub-admins: admins.role / admins.created_by and merchants.created_by_admin_id.
 *
 * The API also does this on every boot (src/db/ensureSchema.js); this is the
 * by-hand route, sharing the boot step's code. Idempotent either way.
 */
async function main() {
  const conn = await pool.getConnection()
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS applied_migrations (name VARCHAR(190) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (name)) ENGINE=InnoDB`)
    await ensureAdminRoles(conn)
    await conn.query('INSERT IGNORE INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('Admin roles are ready. Restart the API so it sees the new columns.')
  } finally {
    conn.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
