import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Creates the `plans` table and seeds the three plans that were previously
 * hardcoded (Starter / Growth / Enterprise, monthly IQD prices), so existing
 * merchants and the Platform MRR are unchanged. After this, the Super Admin
 * designs plans in the UI and MRR reads from this table.
 *
 *   npm run db:add-plans
 */
const NAME = 'add-plans'

const SEED = [
  { name: 'Starter', price: 65000, description: 'For a single small business getting started.', features: ['1 branch', 'Menu / catalog', 'WhatsApp orders'] },
  { name: 'Growth', price: 195000, description: 'For growing businesses that need more.', features: ['Up to 3 branches', 'Customer reviews', 'Priority support'] },
  { name: 'Enterprise', price: 390000, description: 'For established businesses at scale.', features: ['Unlimited branches', 'All features', 'Dedicated support'] },
]

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

    await conn.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name        VARCHAR(80)     NOT NULL,
        price       DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
        period_days INT UNSIGNED    NOT NULL DEFAULT 30,
        description VARCHAR(255)    NULL,
        features    JSON            NULL,
        active      TINYINT(1)      NOT NULL DEFAULT 1,
        position    INT UNSIGNED    NOT NULL DEFAULT 0,
        created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_plans_name (name)
      ) ENGINE=InnoDB`)
    console.log('plans table ready')

    // Seed the three legacy plans (idempotent via INSERT IGNORE on the unique name).
    let position = 0
    for (const p of SEED) {
      await conn.query(
        'INSERT IGNORE INTO plans (name, price, period_days, description, features, position) VALUES (?, ?, 30, ?, ?, ?)',
        [p.name, p.price, p.description, JSON.stringify(p.features), position++],
      )
    }
    console.log(`Seeded ${SEED.length} plan(s)`)

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Plans are now managed in the database.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
