import 'dotenv/config'
import mysql from 'mysql2/promise'

const connection = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'restaurant_saas',
})
try {
  await connection.query(`CREATE TABLE IF NOT EXISTS admin_notification_states (
    admin_id BIGINT UNSIGNED NOT NULL, event_id VARCHAR(80) NOT NULL,
    read_at TIMESTAMP NULL, deleted_at TIMESTAMP NULL,
    PRIMARY KEY (admin_id, event_id),
    CONSTRAINT fk_notification_states_admin FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`)
  console.log('Notification state table is ready')
} finally {
  await connection.end()
}
