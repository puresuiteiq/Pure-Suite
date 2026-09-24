/**
 * Turn a MySQL driver error into an HTTP status + a message that says what to
 * do about it.
 *
 * Every one of these used to reach the browser as a bare "Internal server
 * error", which is indistinguishable from a crash — so a database that was
 * merely missing a migration looked like broken code. The mapped cases are all
 * operational (schema drift, charset, connectivity); anything unrecognised
 * still falls back to a 500 that at least names the driver's error code,
 * because an unexpected error may carry detail that shouldn't be shown to a
 * client.
 *
 * `err.code` values are stable MySQL/driver identifiers, not user data, so
 * echoing the mapped message leaks nothing sensitive.
 */

const MIGRATION_HINT =
  'the database is missing a migration — run the db:* scripts in backend/package.json (see backend/README.md) and restart the API'

/**
 * A write had a value for a merchants column this database doesn't have.
 *
 * Unlike the errors below this isn't raised by MySQL — the controllers skip a
 * missing column rather than letting the whole write fail, which is right for
 * a field nobody asked about and wrong for one the admin typed. Callers use
 * this message either way: in the log for a skipped field, in the response for
 * a value the caller explicitly sent.
 */
export function missingColumnMessage(column) {
  return (
    `This database has no merchants.${column} column, so that value cannot be ` +
    `saved: ${MIGRATION_HINT}. Restarting the API also adds it — see ` +
    'src/db/ensureSchema.js.'
  )
}

/** @returns {{ status: number, error: string } | null} */
export function describeDbError(err) {
  if (!err || typeof err.code !== 'string') return null
  const message = err.sqlMessage || err.message || ''

  // Checked before the code switch: MySQL reports a character that the column's
  // charset cannot represent (an Arabic business name in a latin1 column) as
  // ER_TRUNCATED_WRONG_VALUE_FOR_FIELD — the same code it uses for ordinary
  // type mismatches. Only the message distinguishes them, and the fix is
  // completely different, so match on it first.
  if (/incorrect string value/i.test(message)) {
    return {
      status: 409,
      error: `The database cannot store these characters in ${columnFrom(err)} — it is not using utf8mb4. Run "npm run db:fix-charset" in backend/ and restart the API.`,
    }
  }

  switch (err.code) {
    // A column the query writes doesn't exist in this database.
    case 'ER_BAD_FIELD_ERROR':
      return {
        status: 500,
        error: `This database doesn't have a column the app expects (${columnFrom(err)}): ${MIGRATION_HINT}.`,
      }

    // A whole table is missing — usually db:init was never run.
    case 'ER_NO_SUCH_TABLE':
      return {
        status: 500,
        error: `A database table is missing (${tableFrom(err)}): run "npm run db:init" in backend/, then the db:* migrations.`,
      }

    // The database named by DB_NAME isn't there at all.
    case 'ER_BAD_DB_ERROR':
      return {
        status: 503,
        error: `The database named in DB_NAME doesn't exist (${message.trim() || 'unknown database'}). Run "npm run db:init" in backend/, or fix DB_NAME in backend/.env.`,
      }

    // A value the column can't hold. WARN_DATA_TRUNCATED (1265) is what an
    // invalid ENUM value raises — e.g. an admin-designed plan written to a
    // merchants.plan that predates db:widen-plan.
    case 'WARN_DATA_TRUNCATED':
    case 'ER_WARN_DATA_OUT_OF_RANGE':
    case 'ER_TRUNCATED_WRONG_VALUE':
    case 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD':
    case 'ER_WRONG_VALUE_FOR_TYPE':
    case 'ER_DATA_TOO_LONG':
      return {
        status: 409,
        error: `The database rejected a value for ${columnFrom(err)} — it doesn't fit that column. If you just picked an admin-designed plan, run "npm run db:widen-plan"; otherwise ${MIGRATION_HINT}.`,
      }

    // This install marks a column NOT NULL that the app has no value for, and
    // the column carries no DEFAULT — so MySQL refuses the row over a field the
    // user was never asked to fill. Both codes mean the same thing to an
    // operator (1364 for an omitted column, 1048 for an explicit NULL).
    case 'ER_NO_DEFAULT_FOR_FIELD':
    case 'ER_BAD_NULL_ERROR':
      return {
        status: 409,
        error: `This database requires a value for ${columnFrom(err)}, a field this form doesn't collect. Give that column a DEFAULT (or allow NULL), or ${MIGRATION_HINT}.`,
      }

    // A UNIQUE key collision the calling controller didn't claim. Naming the
    // key (never the value) is enough to point at the right field.
    case 'ER_DUP_ENTRY':
      return {
        status: 409,
        error: `That value is already taken — it collides with the unique index ${keyFrom(err)}.`,
      }

    // Foreign keys: pointing at a row that isn't there, or deleting one that is
    // still referenced.
    case 'ER_NO_REFERENCED_ROW':
    case 'ER_NO_REFERENCED_ROW_2':
      return {
        status: 409,
        error: 'That record references something that no longer exists — reload the page and try again.',
      }
    case 'ER_ROW_IS_REFERENCED':
    case 'ER_ROW_IS_REFERENCED_2':
      return {
        status: 409,
        error: 'That record is still referenced by other data, so it cannot be removed.',
      }

    case 'ER_CHECK_CONSTRAINT_VIOLATED':
      return {
        status: 409,
        error: 'The database rejected that value as out of range for this field.',
      }

    // Explicit charset conversion failure (MySQL 8), distinct from the
    // message-matched case above.
    case 'ER_INVALID_CHARACTER_STRING':
    case 'ER_CANNOT_CONVERT_STRING':
      return {
        status: 409,
        error:
          'The database cannot store these characters — it is not using utf8mb4. Run "npm run db:fix-charset" in backend/ and restart the API.',
      }

    // The statement was larger than the server will accept. In this app that
    // is always an image: base64 inflates a photo by a third, and a product
    // with several gallery images is a single multi-megabyte UPDATE. MySQL's
    // default max_allowed_packet is 1 MB on some builds — including the XAMPP
    // MariaDB many people develop against — so this is reachable with ordinary
    // photos and otherwise surfaces as an unexplained failure to save.
    case 'ER_NET_PACKET_TOO_LARGE':
      return {
        status: 413,
        error:
          'That save is too large for the database to accept in one statement. ' +
          'It is almost always an image — use fewer or smaller photos, or raise ' +
          "the server's max_allowed_packet (16M is a reasonable value).",
      }

    // Contention, not a bug in the request — worth retrying.
    case 'ER_LOCK_WAIT_TIMEOUT':
    case 'ER_LOCK_DEADLOCK':
      return {
        status: 503,
        error: 'The database was busy with another change. Please try again.',
      }

    // Replica / read-only instance.
    case 'ER_OPTION_PREVENTS_STATEMENT':
      return {
        status: 503,
        error: 'The database is in read-only mode, so nothing can be saved. Check that the API points at the primary instance.',
      }

    // Database unreachable / credentials wrong: the API is up, the DB isn't.
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
    case 'ECONNRESET':
    case 'EPIPE':
    case 'PROTOCOL_CONNECTION_LOST':
    case 'PROTOCOL_SEQUENCE_TIMEOUT':
    case 'ER_CON_COUNT_ERROR':
    case 'ER_TOO_MANY_USER_CONNECTIONS':
      return {
        status: 503,
        error: 'The database is unreachable right now. Check that MySQL is running and DB_HOST/DB_PORT are correct.',
      }

    case 'ER_ACCESS_DENIED_ERROR':
    case 'ER_DBACCESS_DENIED_ERROR':
    case 'ER_TABLEACCESS_DENIED_ERROR':
    case 'ER_COLUMNACCESS_DENIED_ERROR':
      return {
        status: 503,
        error: 'The database refused the connection credentials. Check DB_USER / DB_PASSWORD / DB_NAME.',
      }

    default:
      return null
  }
}

/**
 * MySQL puts the offending identifier in the message, e.g.
 * "Unknown column 'business_type' in 'field list'", "Data truncated for column
 * 'plan' at row 1", "Field 'currency' doesn't have a default value", or
 * "Incorrect string value: '\xD9\x85...' for column 'business_name' at row 1".
 * Pull it out so the response names the actual field instead of making the
 * operator read server logs.
 */
function columnFrom(err) {
  const message = err.sqlMessage || err.message || ''
  const match = /column '([^']+)'/i.exec(message) || /field '([^']+)'/i.exec(message)
  return match ? `"${match[1]}"` : 'one of the fields'
}

function tableFrom(err) {
  const match = /table '([^']+)'/i.exec(err.sqlMessage || err.message || '')
  return match ? `"${match[1]}"` : 'unknown'
}

/** The index a duplicate-key error names — never the duplicated value itself. */
function keyFrom(err) {
  const match = /for key '([^']+)'/i.exec(err.sqlMessage || err.message || '')
  return match ? `"${match[1]}"` : 'on this table'
}
