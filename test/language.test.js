import test from 'node:test'
import assert from 'node:assert/strict'
import { detectLanguage } from '../src/middleware/language.js'

/**
 * Accept-Language -> req.lang.
 *
 * This is the input side of the whole menu-translation feature: an unrecognised
 * header resolves to undefined, which makes the mappers fall back to the text
 * the merchant originally typed. That fallback is correct, but it also means a
 * header bug is invisible rather than loud — a storefront just quietly shows
 * untranslated names. Hence the explicit cases below.
 */

/** Minimal Express-ish request carrying one header. */
function reqWith(acceptLanguage) {
  return {
    get: (name) =>
      name.toLowerCase() === 'accept-language' ? acceptLanguage : undefined,
  }
}

function run(acceptLanguage) {
  const req = reqWith(acceptLanguage)
  let called = false
  detectLanguage(req, {}, () => {
    called = true
  })
  assert.equal(called, true, 'middleware must always call next()')
  return req.lang
}

test('accepts exactly the three supported codes', () => {
  assert.equal(run('en'), 'en')
  assert.equal(run('ar'), 'ar')
  assert.equal(run('ku-badini'), 'ku-badini')
})

test('takes the first tag and drops any q-weight', () => {
  assert.equal(run('ar,en;q=0.9'), 'ar')
  assert.equal(run('ar;q=0.8'), 'ar')
  assert.equal(run('  ar  , en'), 'ar', 'whitespace is trimmed')
})

test('an unsupported or regional tag resolves to undefined, not a guess', () => {
  // undefined makes the mappers use the merchant's original text. Note this is
  // why the frontend has to send a bare 'en' rather than the browser default:
  // 'en-US' is NOT accepted here.
  assert.equal(run('en-US,en;q=0.9'), undefined)
  assert.equal(run('fr'), undefined)
  assert.equal(run('ku'), undefined, 'bare ku is not the Badini resource code')
  assert.equal(run(''), undefined)
  assert.equal(run(undefined), undefined)
})

test('never throws on a malformed header', () => {
  assert.doesNotThrow(() => run(';;;,,,'))
  assert.doesNotThrow(() => run('*'))
})
