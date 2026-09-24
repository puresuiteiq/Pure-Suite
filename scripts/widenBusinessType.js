import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Widens merchants.business_type from the original ENUM('restaurant','store') to
 * VARCHAR(60), so it can hold many business categories and custom names.
 *
 * Only needed for installs that already ran db:add-business-type while it still
 * created an ENUM; fresh installs get VARCHAR directly. Idempotent — checks the
 * current column type and only alters when it isn't already a VARCHAR.
 *
 *   npm run db:widen-business-type
 */
const NAME = 'widen-business-type'

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
       WHERE table_schema = DATABASE() AND table_name = 'merchants'
         AND column_name = 'business_type'`,
    )
    if (!cols.length) {
      console.log('merchants.business_type does not exist yet — run db:add-business-type first.')
      return
    }
    if (cols[0].DATA_TYPE.toLowerCase() === 'varchar') {
      console.log('business_type is already VARCHAR — nothing to widen.')
    } else {
      await conn.query(
        "ALTER TABLE merchants MODIFY business_type VARCHAR(60) NOT NULL DEFAULT 'restaurant'",
      )
      console.log('Widened business_type to VARCHAR(60).')
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
