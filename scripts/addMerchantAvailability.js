import 'dotenv/config'
import mysql from 'mysql2/promise'

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'restaurant_saas',
  })
  try {
    try {
      await connection.query(
        'ALTER TABLE merchants ADD COLUMN is_open BOOLEAN NOT NULL DEFAULT TRUE AFTER status',
      )
      console.log('Added merchant availability column')
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log('Merchant availability column already exists')
      } else {
        throw err
      }
    }
  } finally {
    await connection.end()
  }
}

run().catch((err) => {
  console.error('Failed to add merchant availability:', err.message)
  process.exit(1)
})
