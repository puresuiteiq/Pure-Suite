import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Adds merchants.subscription_starts_at — the date the Super Admin says a
 * merchant's current subscription cycle began, alongside the existing
 * subscription_expires_at ("ends"). Purely informational/admin-set (renew
 * only ever touches subscription_expires_at); NULL = not set. The app
 * tolerates this column being absent, so this migration only *enables* the
 * field.
 *
 *   npm run db:add-subscription-start
 */
const NAME = 'add-subscription-start'

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

    console.log('Adding merchant subscription start:')
    await addColumn(conn, 'merchants', 'subscription_starts_at', 'DATE NULL AFTER subscription_expires_at')

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Set a start date per merchant from the Edit Merchant form.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
