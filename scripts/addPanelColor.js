import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Adds merchants.panel_color + merchants.panel_shadow — the two brand colours a
 * merchant picks for their ADMIN PANEL buttons (Save, Add, Download, …), kept
 * separate from the storefront accent (accent_color/accent_shadow). Both NULL by
 * default, so the panel keeps its default amber until the merchant chooses.
 *
 *   npm run db:add-panel-color
 */
const NAME = 'add-panel-color'

async function addColumn(conn, table, column, definition) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  )
  if (rows[0].n > 0) {
    console.log(`  ${table}.${column} already present — skipped`)
    return false
  }
  await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  console.log(`  ${table}.${column} added`)
  return true
}

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

    console.log('Adding merchant admin-panel brand colours:')
    await addColumn(conn, 'merchants', 'panel_color', 'VARCHAR(9) NULL')
    await addColumn(conn, 'merchants', 'panel_shadow', 'VARCHAR(9) NULL')

    await conn.query('INSERT INTO applied_migrations (name) VALUES (?)', [NAME])
    console.log('\nDone. Panels keep their default colour until a merchant sets their own.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
