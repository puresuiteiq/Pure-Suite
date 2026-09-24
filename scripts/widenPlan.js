import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Widens merchants.plan from the original ENUM('Starter','Growth','Enterprise')
 * to VARCHAR(80), so any plan the Super Admin designs can be assigned. merchants
 * reference a plan by its name string. Idempotent — only alters when the column
 * isn't already a VARCHAR.
 *
 *   npm run db:widen-plan
 */
const NAME = 'widen-plan'

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
      `SELECT DATA_TYPE FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = 'plan'`,
    )
    if (!cols.length) {
      console.log('merchants.plan does not exist — nothing to widen.')
    } else if (cols[0].DATA_TYPE.toLowerCase() === 'varchar') {
      console.log('merchants.plan is already VARCHAR — nothing to widen.')
    } else {
      await conn.query(
        "ALTER TABLE merchants MODIFY plan VARCHAR(80) NOT NULL DEFAULT 'Starter'",
      )
      console.log('Widened merchants.plan to VARCHAR(80).')
    }

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('Done.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
