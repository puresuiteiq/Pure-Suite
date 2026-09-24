import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

/**
 * Applies db/schema.sql to the configured MySQL server, inside DB_NAME.
 * Connects WITHOUT a target database first so it can CREATE DATABASE IF NOT
 * EXISTS on a host that allows it (plain local MySQL) — that create is
 * harmless/a no-op on a host that already has DB_NAME provisioned for you
 * (Railway, PlanetScale, etc.) and lacks permission to create another one,
 * since IF NOT EXISTS makes it succeed either way. Then USEs that database
 * before applying schema.sql, which itself stays database-name-agnostic.
 *
 * Usage: npm run db:init      (optionally: npm run db:init -- --seed)
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const withSeed = process.argv.includes('--seed')
const dbName = process.env.DB_NAME || 'restaurant_saas'

async function applyFile(connection, relativePath) {
  const sql = await readFile(path.join(__dirname, '..', relativePath), 'utf8')
  await connection.query(sql)
  console.log(`✔ Applied ${relativePath}`)
}

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  })

  try {
    try {
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      )
    } catch (err) {
      // A managed host may not grant CREATE privileges beyond the one
      // database it already gave you — fine, as long as that database
      // (DB_NAME) already exists, which the USE right below will verify.
      console.warn(`(skipped CREATE DATABASE — ${err.message})`)
    }
    await connection.query(`USE \`${dbName}\``)

    await applyFile(connection, 'db/schema.sql')
    if (withSeed) await applyFile(connection, 'db/seed.sql')
    console.log(`Database "${dbName}" initialized.`)
  } finally {
    await connection.end()
  }
}

run().catch((err) => {
  console.error('✖ Failed to initialize database:', err.message)
  process.exit(1)
})
