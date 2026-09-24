import 'dotenv/config'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import bcrypt from 'bcryptjs'

/**
 * First-run bootstrap: takes an empty database all the way to "you can sign in".
 *
 * This exists because that was not previously possible. `db:init` creates the
 * `admins` and `plans` tables but seeds neither, and the only thing that ever
 * created an admin — `db:setup-auth` — was documented under "Migrations
 * (required on an existing database)". A new operator following the README top
 * to bottom therefore ended up with a complete schema, no accounts, and no way in.
 *
 * Applies db/schema.sql (every CREATE is IF NOT EXISTS, so this is safe on an
 * existing database too), then seeds:
 *   - one Super Admin, with a generated password printed once
 *   - the three subscription plans, priced to match PLAN_PRICES in
 *     src/controllers/overviewController.js — if these disagree, the MRR tile on
 *     System Overview and the Subscription Plans page show different numbers
 *   - the service-status board entries the overview renders
 *
 * Credentials come from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD when set. With no
 * SEED_ADMIN_PASSWORD a strong one is generated and printed once — this script
 * deliberately has no hardcoded default password, because the previous one
 * ("admin123") was committed to the repo and could only be changed with raw SQL.
 *
 *   npm run db:bootstrap              # schema + accounts + plans + services
 *   npm run db:bootstrap -- --demo    # also load db/seed.sql demo content
 *   npm run db:bootstrap -- --force   # reset the admin password and re-seed
 */
const NAME = 'seed-bootstrap'
// Seeding db/seed.sql already in dinars means the USD->IQD migration must never
// run over it; recording it here is what stops `db:convert-iqd` multiplying
// those prices by 1300 a second time.
const IQD_MIGRATION = 'convert-prices-to-iqd'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const withDemo = argv.includes('--demo') || argv.includes('--seed')
const force = argv.includes('--force')

const dbName = process.env.DB_NAME || 'restaurant_saas'
const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@restosaas.com').trim()
const adminName = (process.env.SEED_ADMIN_NAME || 'Platform Admin').trim()

/** Prices are IQD per billing period, mirroring overviewController.PLAN_PRICES. */
const PLANS = [
  {
    name: 'Starter',
    price: 65000,
    periodDays: 30,
    description: 'For a single small business getting started.',
    features: ['1 branch', 'Menu / catalog', 'WhatsApp orders'],
  },
  {
    name: 'Growth',
    price: 195000,
    periodDays: 30,
    description: 'For growing businesses that need more.',
    features: ['Up to 3 branches', 'Customer reviews', 'Priority support'],
  },
  {
    name: 'Enterprise',
    price: 390000,
    periodDays: 30,
    description: 'For established businesses at scale.',
    features: ['Unlimited branches', 'All features', 'Dedicated support'],
  },
]

const SERVICES = [
  { name: 'API', status: 'operational', uptime: 100 },
  { name: 'Database', status: 'operational', uptime: 100 },
  { name: 'Storefronts', status: 'operational', uptime: 100 },
  { name: 'Order intake', status: 'operational', uptime: 100 },
]

/** A strong, typeable password. Printed once; never stored in plaintext. */
function generatePassword() {
  return crypto.randomBytes(12).toString('base64url')
}

async function applyFile(conn, relativePath) {
  const sql = await readFile(path.join(__dirname, '..', relativePath), 'utf8')
  await conn.query(sql)
  console.log(`  applied ${relativePath}`)
}

async function seedAdmin(conn) {
  const [existing] = await conn.query('SELECT id FROM admins WHERE email = ?', [adminEmail])
  const supplied = process.env.SEED_ADMIN_PASSWORD

  if (existing.length && !force) {
    console.log(`  admin ${adminEmail} already exists — left untouched`)
    return null
  }

  const password = supplied || generatePassword()
  const hash = await bcrypt.hash(password, 10)

  if (existing.length) {
    await conn.query('UPDATE admins SET password_hash = ? WHERE email = ?', [hash, adminEmail])
    console.log(`  admin ${adminEmail} password reset (--force)`)
  } else {
    await conn.query('INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)', [
      adminName,
      adminEmail,
      hash,
    ])
    console.log(`  admin ${adminEmail} created`)
  }
  // Only hand back a password we generated — never echo one the operator set.
  return supplied ? null : password
}

async function seedPlans(conn) {
  let added = 0
  for (const [position, plan] of PLANS.entries()) {
    const [result] = await conn.query(
      `INSERT IGNORE INTO plans (name, price, period_days, description, features, active, position)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [
        plan.name,
        plan.price,
        plan.periodDays,
        plan.description,
        JSON.stringify(plan.features),
        position,
      ],
    )
    if (result.affectedRows) added += 1
  }
  console.log(added ? `  ${added} plan(s) added` : '  plans already present — skipped')
}

async function seedServices(conn) {
  const [rows] = await conn.query('SELECT COUNT(*) AS n FROM service_status')
  if (rows[0].n > 0) {
    console.log('  service status board already populated — skipped')
    return
  }
  for (const [position, svc] of SERVICES.entries()) {
    await conn.query(
      'INSERT INTO service_status (name, status, uptime, position) VALUES (?, ?, ?, ?)',
      [svc.name, svc.status, svc.uptime, position],
    )
  }
  console.log(`  ${SERVICES.length} service status entries added`)
}

async function main() {
  // Connect without a target database so CREATE DATABASE is possible on a plain
  // local MySQL; harmless on a managed host that already provisioned one.
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
    multipleStatements: true, // schema.sql is many statements in one file
  })

  try {
    try {
      await conn.query(
        'CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
        [dbName],
      )
    } catch (err) {
      // A managed host may grant no CREATE beyond the database it gave you.
      // Fine, as long as DB_NAME exists — the USE below verifies that.
      console.warn(`(skipped CREATE DATABASE — ${err.message})`)
    }
    await conn.query('USE ??', [dbName])

    console.log('Schema:')
    await applyFile(conn, 'db/schema.sql')
    if (withDemo) await applyFile(conn, 'db/seed.sql')

    await conn.query(`
      CREATE TABLE IF NOT EXISTS applied_migrations (
        name       VARCHAR(190) NOT NULL,
        applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (name)
      ) ENGINE=InnoDB`)

    const [done] = await conn.query('SELECT applied_at FROM applied_migrations WHERE name = ?', [
      NAME,
    ])
    if (done.length && !force) {
      console.log(
        `\nAlready bootstrapped on ${done[0].applied_at.toISOString()}.` +
          '\nRe-run with --force to reset the admin password and re-seed.',
      )
      return
    }

    console.log('\nAccounts and defaults:')
    const generatedPassword = await seedAdmin(conn)
    await seedPlans(conn)
    await seedServices(conn)

    // db/seed.sql ships prices already in dinars, so the USD->IQD conversion
    // must never run over this data.
    await conn.query('INSERT IGNORE INTO applied_migrations (name) VALUES (?)', [IQD_MIGRATION])
    await conn.query('INSERT IGNORE INTO applied_migrations (name) VALUES (?)', [NAME])

    console.log(`\nDatabase "${dbName}" is ready.`)
    if (generatedPassword) {
      console.log('\n  --- Super Admin: this password is shown once, copy it now ---')
      console.log(`      email:    ${adminEmail}`)
      console.log(`      password: ${generatedPassword}`)
      console.log('  -------------------------------------------------------------')
      console.log('\n  Change it after signing in (user menu -> Change password).')
    } else {
      console.log(`\n  Super Admin: ${adminEmail} (password as supplied via SEED_ADMIN_PASSWORD)`)
    }
    console.log('\nStart the API with: npm run dev')
  } catch (err) {
    console.error('Bootstrap failed:', err.message)
    process.exitCode = 1
  } finally {
    await conn.end()
  }
}

main()
