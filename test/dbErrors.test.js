import test from 'node:test'
import assert from 'node:assert/strict'
import { describeDbError, missingColumnMessage } from '../src/utils/dbErrors.js'

/**
 * Operational database failures.
 *
 * This project's characteristic failure is a database that is missing a
 * migration: reads work, writes fail, and the admin used to see nothing but
 * "Internal server error". These mappings are what turn that into a message
 * naming the actual problem, so they are worth pinning down — particularly the
 * status codes, since a 503 tells an operator to look at the database while a
 * 409 tells them to look at their input.
 */

const err = (code, sqlMessage = '') => ({ code, sqlMessage })

test('returns null for anything it cannot classify', () => {
  assert.equal(describeDbError(null), null)
  assert.equal(describeDbError(undefined), null)
  assert.equal(describeDbError(new Error('plain')), null, 'no .code')
  assert.equal(describeDbError(err('ER_SOMETHING_UNKNOWN')), null)
})

test('connectivity problems are 503 — the operator, not the caller, must act', () => {
  for (const code of [
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNRESET',
    'PROTOCOL_CONNECTION_LOST',
    'ER_CON_COUNT_ERROR',
  ]) {
    const described = describeDbError(err(code))
    assert.ok(described, `${code} should be classified`)
    assert.equal(described.status, 503, `${code} should be 503`)
  }
})

test('access denied is 503, not 401 — it is a server misconfiguration', () => {
  // A caller cannot fix the API's own database credentials, so this must never
  // read as an authentication failure aimed at the user.
  assert.equal(describeDbError(err('ER_ACCESS_DENIED_ERROR')).status, 503)
  assert.equal(describeDbError(err('ER_DBACCESS_DENIED_ERROR')).status, 503)
})

test('lock contention is 503 and reads as retryable', () => {
  assert.equal(describeDbError(err('ER_LOCK_DEADLOCK')).status, 503)
  assert.equal(describeDbError(err('ER_LOCK_WAIT_TIMEOUT')).status, 503)
})

test('a missing column or table is 500 — the deploy is inconsistent', () => {
  assert.equal(describeDbError(err('ER_BAD_FIELD_ERROR')).status, 500)
  assert.equal(describeDbError(err('ER_NO_SUCH_TABLE')).status, 500)
})

test('a missing database is 503', () => {
  assert.equal(describeDbError(err('ER_BAD_DB_ERROR')).status, 503)
})

test('unstorable values are 409 and name the column', () => {
  const described = describeDbError(
    err('WARN_DATA_TRUNCATED', "Data truncated for column 'plan' at row 1"),
  )
  assert.equal(described.status, 409)
  assert.match(described.error, /plan/, 'the message should name the column')
})

test('a duplicate key is 409 and names the index, never the value', () => {
  const described = describeDbError(
    err('ER_DUP_ENTRY', "Duplicate entry 'secret@example.com' for key 'uq_merchants_email'"),
  )
  assert.equal(described.status, 409)
  assert.match(described.error, /uq_merchants_email/)
  assert.doesNotMatch(
    described.error,
    /secret@example\.com/,
    'the colliding value must not be echoed back — it can be someone else data',
  )
})

test('a NOT NULL violation is 409', () => {
  assert.equal(describeDbError(err('ER_BAD_NULL_ERROR')).status, 409)
  assert.equal(describeDbError(err('ER_NO_DEFAULT_FOR_FIELD')).status, 409)
})

test('a latin1 database rejecting Arabic is 409 and names the fix', () => {
  // Without this, storing any Arabic text fails with an opaque error on a
  // server that defaults to latin1.
  const described = describeDbError({
    code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
    sqlMessage: "Incorrect string value: '\\xD8\\xAD' for column 'business_name' at row 1",
  })
  assert.equal(described.status, 409)
  assert.match(described.error, /db:fix-charset/, 'should name the migration that fixes it')
})

test('missingColumnMessage names the column and points at the fix', () => {
  const message = missingColumnMessage('slug')
  assert.match(message, /slug/)
  assert.match(message, /migration/i)
  assert.equal(typeof message, 'string')
})

test('an oversized statement is 413 and points at the real cause', () => {
  // Reachable with ordinary phone photos: base64 inflates by a third, and some
  // MySQL builds ship a 1 MB max_allowed_packet. Without this it surfaced as a
  // generic 500 and looked like a crash rather than a limit.
  const described = describeDbError(err('ER_NET_PACKET_TOO_LARGE'))
  assert.equal(described.status, 413)
  assert.match(described.error, /image/i, 'should name the likely cause')
  assert.match(described.error, /max_allowed_packet/, 'should name the setting to raise')
})
