import 'dotenv/config'
import pool from '../src/config/db.js'

const NAME = 'add-price-color'

async function addColumn(conn, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = ?`,
    [column],
  )
  if (rows[0].n) return
  await conn.query(`ALTER TABLE merchants ADD COLUMN ${column} VARCHAR(9) NULL`)
}

async function main() {
  const conn = await pool.getConnection()
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS applied_migrations (name VARCHAR(190) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (name)) ENGINE=InnoDB`)
    const [done] = await conn.query('SELECT name FROM applied_migrations WHERE name = ?', [NAME])
    if (done.length) return
    await addColumn(conn, 'price_color')
    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('Price colour column added.')
  } finally {
    conn.release()
    await pool.end()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
