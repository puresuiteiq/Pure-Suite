import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Per-merchant read/deleted state for the merchant notifications feed (mirrors
 * admin_notification_states). Notifications themselves are computed on the fly
 * from the merchant's own orders / reviews / subscription expiry; this table
 * only remembers which the merchant has read or dismissed.
 *
 *   npm run db:add-merchant-notif
 */
const NAME = 'add-merchant-notification-states'

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

    console.log('Creating merchant_notification_states:')
    await conn.query(`
      CREATE TABLE IF NOT EXISTS merchant_notification_states (
        merchant_id BIGINT UNSIGNED NOT NULL,
        event_id    VARCHAR(80)     NOT NULL,
        read_at     TIMESTAMP       NULL,
        deleted_at  TIMESTAMP       NULL,
        PRIMARY KEY (merchant_id, event_id),
        CONSTRAINT fk_merchant_notif_states_merchant
          FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
      ) ENGINE=InnoDB`)
    console.log('  merchant_notification_states created')

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Merchants now have their own notifications feed state.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
