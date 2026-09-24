import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SLUG_MAX,
  slugify,
  fallbackSlug,
  slugForMerchant,
  validateSlug,
} from '../src/utils/slug.js'

/**
 * Storefront slugs. These are printed onto QR codes that get scanned for
 * months, so the invariants below are not cosmetic: a slug that collides with
 * the numeric-id form, or that changes shape between create-time and the boot
 * backfill, breaks a code someone already stuck to a table.
 */

test('slugify: derives a URL-safe slug from a business name', () => {
  assert.equal(slugify('Tech Zone'), 'tech-zone')
  assert.equal(slugify('  The  Olive   Branch  '), 'the-olive-branch')
  assert.equal(slugify('Café Amir'), 'cafe-amir', 'Latin accents fold to ASCII')
  assert.equal(slugify('A/B\\C_D.E'), 'a-b-c-d-e', 'separators collapse to hyphens')
  assert.equal(slugify('--Trim--Me--'), 'trim-me')
})

test('slugify: a name with no Latin characters yields nothing usable', () => {
  // The caller turns '' into the m<id> form. A percent-encoded Arabic slug
  // would be unreadable the moment it is printed or pasted.
  assert.equal(slugify('نكهة بغداد'), '')
  assert.equal(slugify('!!!'), '')
  assert.equal(slugify(null), '')
  assert.equal(slugify(undefined), '')
})

test('slugify: never produces a purely numeric slug', () => {
  // /r/:param treats a bare number as a merchant id, so a numeric slug would
  // be ambiguous with every pre-slug QR code.
  assert.equal(slugify('2024'), 'm2024')
  assert.doesNotMatch(slugify('777'), /^\d+$/)
})

test('slugify: respects the length cap without leaving a trailing hyphen', () => {
  const slug = slugify('a '.repeat(200))
  assert.ok(slug.length <= SLUG_MAX)
  assert.doesNotMatch(slug, /-$/)
})

test('slugForMerchant: prefers the name, then name-id, then m<id>', async () => {
  const free = async () => false
  assert.equal(await slugForMerchant('Tech Zone', 5, free), 'tech-zone')

  // Name taken -> falls through to the id-suffixed form.
  const nameTaken = async (candidate) => candidate === 'tech-zone'
  assert.equal(await slugForMerchant('Tech Zone', 5, nameTaken), 'tech-zone-5')

  // Both taken -> the m<id> fallback.
  const bothTaken = async (c) => c === 'tech-zone' || c === 'tech-zone-5'
  assert.equal(await slugForMerchant('Tech Zone', 5, bothTaken), 'm5')
})

test('slugForMerchant: an Arabic-only name goes straight to m<id>', async () => {
  assert.equal(await slugForMerchant('نكهة بغداد', 12, async () => false), 'm12')
  assert.equal(fallbackSlug(12), 'm12')
})

test('slugForMerchant: terminates even when everything collides', async () => {
  // Guards against the caller hanging on a pathological database.
  const result = await slugForMerchant('Tech Zone', 5, async () => true)
  assert.equal(typeof result, 'string')
  assert.ok(result.length > 0)
})

test('validateSlug: accepts lowercase letters, digits and single hyphens', () => {
  assert.deepEqual(validateSlug('mamo'), { value: 'mamo' })
  assert.deepEqual(validateSlug('  Tech-Zone-2  '), { value: 'tech-zone-2' })
})

test('validateSlug: rejects what would break a printed link', () => {
  assert.ok(validateSlug('').error, 'empty')
  assert.ok(validateSlug('   ').error, 'whitespace only')
  assert.ok(validateSlug('7').error, 'numeric collides with the id form')
  assert.ok(validateSlug('a--b').error, 'double hyphen')
  assert.ok(validateSlug('-abc').error, 'leading hyphen')
  assert.ok(validateSlug('abc-').error, 'trailing hyphen')
  assert.ok(validateSlug('نكهة').error, 'non-Latin')
  assert.ok(validateSlug('a'.repeat(SLUG_MAX + 1)).error, 'over the cap')
})

test('validateSlug and slugify agree: a generated slug always validates', () => {
  // create-time and the boot backfill must never disagree about a slug's shape.
  for (const name of ['Tech Zone', 'Café Amir', 'The  Olive  Branch', '2024 Store']) {
    const generated = slugify(name)
    if (!generated) continue
    assert.equal(
      validateSlug(generated).value,
      generated,
      `slugify produced "${generated}" for "${name}", which validateSlug rejects`,
    )
  }
})
