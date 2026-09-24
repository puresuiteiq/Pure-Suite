import 'dotenv/config'
import mysql from 'mysql2/promise'

// Nudge against shipping a passwordless DB user to production.
if (process.env.NODE_ENV === 'production' && !process.env.DB_PASSWORD) {
  // eslint-disable-next-line no-console
  console.warn(
    '[db] DB_PASSWORD is empty in production. Use a dedicated MySQL user with a strong password.',
  )
}

/**
 * Shared MySQL connection pool. `createPool` is lazy — it doesn't open a
 * connection until the first query — so importing this never blocks server
 * startup even when the database is unreachable.
 */
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'restaurant_saas',
  // Pinned so Arabic/emoji text is never mangled by the driver default,
  // which is utf8mb3. The tables must be utf8mb4 too — npm run db:fix-charset.
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
})

/**
 * Acquire a connection and run a trivial query to confirm the database is
 * reachable. Throws if the connection cannot be established.
 */
export async function pingDatabase() {
  const connection = await pool.getConnection()
  try {
    await connection.query('SELECT 1')
  } finally {
    connection.release()
  }
}

export default pool
