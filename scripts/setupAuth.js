import 'dotenv/config'
import crypto from 'node:crypto'
import mysql from 'mysql2/promise'
import bcrypt from 'bcryptjs'

/**
 * Brings login support to a database that predates it:
 *  1. Adds merchants.password_hash if missing.
 *  2. Optionally sets a shared password on merchants that have none, so a
 *     pre-auth database has usable demo logins.
 *  3. Ensures the admins table exists.
 *
 * For a NEW database use `npm run db:bootstrap` instead — it applies the schema
 * and seeds the Super Admin, plans and service board in one step.
 *
 * This script no longer contains any password. It previously hardcoded
 * "admin123" for the Super Admin and stamped "password123" onto every
 * passwordless merchant — both committed to the repo, and the admin one could
 * only be changed with raw SQL because no change-password endpoint existed.
 * Supply MERCHANT_DEMO_PASSWORD to set merchant passwords, or one is generated
 * and printed once.
 *
 * Step 2 refuses to run when NODE_ENV=production: giving every passwordless
 * merchant on a live platform the same known password is not a migration, it is
 * an incident.
 *
 *   npm run db:setup-auth
 */
async function run() {
  const isProd = process.env.NODE_ENV === 'production'
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'restaurant_saas',
    charset: 'utf8mb4',
  })

  try {
    try {
      await connection.query(
        'ALTER TABLE merchants ADD COLUMN password_hash VARCHAR(255) NULL AFTER email',
      )
      console.log('✔ Added password_hash column')
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log('• password_hash column already present')
      } else {
        throw err
      }
    }

    // --- Merchant demo passwords ---
    const [pending] = await connection.query(
      "SELECT COUNT(*) AS n FROM merchants WHERE password_hash IS NULL OR password_hash = ''",
    )
    const passwordless = Number(pending[0].n)

    if (passwordless === 0) {
      console.log('• every merchant already has a password — nothing to set')
    } else if (isProd) {
      console.log(
        `• ${passwordless} merchant(s) have no password. Skipped: setting a shared\n` +
          '  password is refused under NODE_ENV=production. Give each one a unique\n' +
          '  credential from the Super Admin panel (Merchant details → Reset password).',
      )
    } else {
      const demoPassword =
        process.env.MERCHANT_DEMO_PASSWORD || crypto.randomBytes(9).toString('base64url')
      const hash = await bcrypt.hash(demoPassword, 10)
      const [result] = await connection.query(
        "UPDATE merchants SET password_hash = ? WHERE password_hash IS NULL OR password_hash = ''",
        [hash],
      )
      console.log(`✔ Set a password on ${result.affectedRows} merchant(s)`)
      if (!process.env.MERCHANT_DEMO_PASSWORD) {
        const [rows] = await connection.query(
          'SELECT email FROM merchants WHERE email IS NOT NULL ORDER BY id LIMIT 1',
        )
        console.log('\n  --- Merchant demo login: shown once, copy it now ---')
        if (rows.length) console.log(`      email:    ${rows[0].email}`)
        console.log(`      password: ${demoPassword}`)
        console.log('  ---------------------------------------------------')
      }
    }

    // --- Admins table ---
    // Created empty on purpose. Seeding an account with a password belongs to
    // db:bootstrap, which generates one instead of shipping a known constant.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name          VARCHAR(150)    NULL,
        email         VARCHAR(190)    NOT NULL,
        password_hash VARCHAR(255)    NOT NULL,
        created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_admins_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    const [admins] = await connection.query('SELECT COUNT(*) AS n FROM admins')
    console.log(
      Number(admins[0].n)
        ? `• admins table ready (${admins[0].n} account(s))`
        : '• admins table ready, but empty — run "npm run db:bootstrap" to create the Super Admin',
    )
  } finally {
    await connection.end()
  }
}

run().catch((err) => {
  console.error('✖ Failed to set up auth:', err.message)
  process.exit(1)
})
