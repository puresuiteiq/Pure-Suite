import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Converts the database and every table in it to utf8mb4 / utf8mb4_unicode_ci.
 *
 * db/schema.sql now pins utf8mb4 per table, but a database created before that
 * inherited whatever the MySQL server defaults to. On a server still defaulting
 * to latin1, storing non-Latin text — an Arabic business name like "مطعم مادو",
 * an Arabic owner name, a custom Arabic business type — fails with "Incorrect
 * string value", which the API could only report as an internal error.
 *
 * Deliberately NOT gated on applied_migrations: it inspects each table and
 * converts only the ones that need it, so re-running after adding tables is
 * safe and useful.
 *
 *   npm run db:fix-charset
 */
const CHARSET = 'utf8mb4'
const COLLATION = 'utf8mb4_unicode_ci'

async function main() {
  const conn = await pool.getConnection()
  try {
    const [[{ db }]] = await conn.query('SELECT DATABASE() AS db')
    if (!db) throw new Error('No database selected — check DB_NAME in .env')

    const [[current]] = await conn.query(
      `SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation
       FROM information_schema.schemata WHERE schema_name = ?`,
      [db],
    )
    console.log(`Database "${db}" is ${current.charset} / ${current.collation}`)

    if (current.charset !== CHARSET) {
      // Only changes the default for tables created later; existing tables are
      // converted individually below.
      await conn.query(`ALTER DATABASE \`${db}\` CHARACTER SET ${CHARSET} COLLATE ${COLLATION}`)
      console.log(`✔ Database default set to ${CHARSET}`)
    } else {
      console.log('• Database default already utf8mb4 — skipped')
    }

    // Tables whose own charset differs. CONVERT TO rewrites the table's columns,
    // so it's skipped where it would be a no-op.
    const [tables] = await conn.query(
      `SELECT t.table_name AS name, ccsa.character_set_name AS charset
         FROM information_schema.tables t
         JOIN information_schema.collation_character_set_applicability ccsa
           ON ccsa.collation_name = t.table_collation
        WHERE t.table_schema = ? AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name`,
      [db],
    )

    let converted = 0
    for (const table of tables) {
      if (table.charset === CHARSET) {
        console.log(`• ${table.name} already ${CHARSET} — skipped`)
        continue
      }
      await conn.query(
        `ALTER TABLE \`${table.name}\` CONVERT TO CHARACTER SET ${CHARSET} COLLATE ${COLLATION}`,
      )
      console.log(`✔ ${table.name}: ${table.charset} → ${CHARSET}`)
      converted += 1
    }

    console.log(
      converted
        ? `\nDone. Converted ${converted} table(s) — restart the API.`
        : '\nDone. Everything was already utf8mb4; nothing to change.',
    )
  } catch (err) {
    console.error('Charset fix failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
