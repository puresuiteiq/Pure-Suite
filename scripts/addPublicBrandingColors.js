import 'dotenv/config'
import pool from '../src/config/db.js'

const NAME = 'add-public-branding-colors'
const COLUMNS = [
  ['public_powered_by_color', 'VARCHAR(9) NULL'],
  ['public_brand_name_color', 'VARCHAR(9) NULL'],
]

async function addColumn(conn, name, definition) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'admins' AND column_name = ?`,
    [name],
  )
  if (!rows[0].n) await conn.query(`ALTER TABLE admins ADD COLUMN ${name} ${definition}`)
}

async function main() {
  const conn = await pool.getConnection()
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS applied_migrations (name VARCHAR(190) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (name)) ENGINE=InnoDB`)
    const [done] = await conn.query('SELECT name FROM applied_migrations WHERE name = ?', [NAME])
    if (!done.length) {
      for (const [name, definition] of COLUMNS) await addColumn(conn, name, definition)
      await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    }
    console.log('Public branding text-colour columns are ready.')
  } finally {
    conn.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
