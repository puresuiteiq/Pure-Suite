import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseI18n,
  pickI18n,
  parseVariants,
  parseAttributes,
  parseImages,
  parseServiceMethods,
  parseSocialLinks,
  parseWorkingHours,
  mapMenuItem,
  groupMenu,
  normalizeI18n,
  SUPPORTED_LANGS,
  STOREFRONT_THEMES,
  normalizeStorefrontTheme,
  mapProfile,
} from '../src/utils/mappers.js'

/**
 * Row -> API mappers.
 *
 * Two things make these worth pinning down. First, every JSON column arrives as
 * a raw string from mysql2 (and as a LONGTEXT string on MariaDB, which is what
 * this project actually runs against), so each parser has to tolerate a string,
 * an already-parsed object, null, and outright garbage without throwing.
 * Second, pickI18n's fallback rule is what keeps a menu entered in one language
 * working in all three — if a blank translation ever stopped counting as
 * absent, storefronts would render empty product names.
 */

test('parseI18n: tolerates strings, objects, null and garbage', () => {
  assert.deepEqual(parseI18n('{"ar":"حمص"}'), { ar: 'حمص' })
  assert.deepEqual(parseI18n({ ar: 'حمص' }), { ar: 'حمص' })
  assert.deepEqual(parseI18n(null), {})
  assert.deepEqual(parseI18n(''), {})
  assert.deepEqual(parseI18n('not json'), {})
  assert.deepEqual(parseI18n('[1,2]'), {}, 'an array is not a translation map')
})

test('pickI18n: returns the translation for the requested language', () => {
  const i18n = { en: 'Hummus', ar: 'حمص', 'ku-badini': 'حومس' }
  assert.equal(pickI18n(i18n, 'Hummus', 'ar'), 'حمص')
  assert.equal(pickI18n(i18n, 'Hummus', 'ku-badini'), 'حومس')
})

test('pickI18n: falls back to what the merchant typed', () => {
  // The whole point of the fallback: a menu entered only in English still
  // renders on an Arabic storefront.
  assert.equal(pickI18n({ en: 'Hummus' }, 'Hummus', 'ar'), 'Hummus')
  assert.equal(pickI18n(null, 'Hummus', 'ar'), 'Hummus')
  assert.equal(pickI18n({}, 'Hummus', 'ar'), 'Hummus')
  assert.equal(pickI18n({ ar: 'حمص' }, 'Hummus', undefined), 'Hummus', 'no lang -> fallback')
})

test('pickI18n: a blank translation counts as absent', () => {
  // The editor sends "" for a language left empty. An empty product name is
  // never better than the original.
  assert.equal(pickI18n({ ar: '' }, 'Hummus', 'ar'), 'Hummus')
  assert.equal(pickI18n({ ar: '   ' }, 'Hummus', 'ar'), 'Hummus')
  assert.equal(pickI18n({ ar: null }, 'Hummus', 'ar'), 'Hummus')
})

test('parseVariants: normalises to { value, price } and tolerates the legacy key', () => {
  assert.deepEqual(parseVariants('[{"value":"Large","price":"9000"}]'), [
    { value: 'Large', price: 9000 },
  ])
  assert.deepEqual(
    parseVariants([{ size_name: 'Large', price: 9000 }]),
    [{ value: 'Large', price: 9000 }],
    'pre-migration rows used size_name',
  )
  assert.deepEqual(parseVariants(null), [])
  assert.deepEqual(parseVariants('garbage'), [])
  assert.deepEqual(parseVariants('{"not":"array"}'), [])
})

test('parseAttributes: keeps only groups that have a name and values', () => {
  const parsed = parseAttributes('[{"name":"Size","values":["S","M"]}]')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].name, 'Size')
  assert.deepEqual(parsed[0].values, ['S', 'M'])

  assert.deepEqual(parseAttributes('[{"name":"","values":["S"]}]'), [], 'no name')
  assert.deepEqual(parseAttributes('[{"name":"Size","values":[]}]'), [], 'no values')
  assert.deepEqual(parseAttributes(null), [])
  assert.deepEqual(parseAttributes('garbage'), [])
})

test('parseImages: always yields an array of truthy strings', () => {
  assert.deepEqual(parseImages('["a","b"]'), ['a', 'b'])
  assert.deepEqual(parseImages(['a', '', null, 'b']), ['a', 'b'])
  assert.deepEqual(parseImages(null), [])
  assert.deepEqual(parseImages('garbage'), [])
})

test('parseServiceMethods: null means "not configured", not "empty config"', () => {
  // The storefront checkout distinguishes these: null keeps the plain checkout
  // with no method picker at all.
  assert.equal(parseServiceMethods(null), null)
  assert.equal(parseServiceMethods('garbage'), null)
  assert.deepEqual(parseServiceMethods('{"pickup":{"enabled":true}}'), {
    pickup: { enabled: true },
  })
})

test('parseSocialLinks: exposes exactly the known platforms', () => {
  const links = parseSocialLinks('{"instagram":" me ","evil":"x"}')
  assert.deepEqual(Object.keys(links).sort(), [
    'facebook',
    'instagram',
    'snapchat',
    'telegram',
    'tiktok',
    'whatsapp',
  ])
  assert.equal(links.instagram, 'me', 'trimmed')
  assert.equal(links.evil, undefined, 'unknown platforms are dropped')
  assert.equal(parseSocialLinks(null).instagram, '')
})

test('parseWorkingHours: returns [] rather than throwing on bad data', () => {
  assert.deepEqual(parseWorkingHours(null), [])
  assert.deepEqual(parseWorkingHours('garbage'), [])
  assert.equal(parseWorkingHours('[{"day":"Monday"}]').length, 1)
})

test('mapMenuItem: resolves display text but still carries the raw maps', () => {
  const row = {
    id: 1,
    name: 'Hummus',
    name_i18n: '{"ar":"حمص"}',
    description: 'Chickpea dip',
    description_i18n: '{"ar":"غموس الحمص"}',
    price: '5000.00',
    original_price: null,
    availability: 'available',
    variants: null,
    attributes: null,
    stock: null,
    images: null,
    image: null,
  }

  const arabic = mapMenuItem(row, 'ar')
  assert.equal(arabic.name, 'حمص', 'display name is resolved')
  assert.deepEqual(arabic.nameI18n, { ar: 'حمص' }, 'editor still gets every language')
  assert.equal(arabic.price, 5000, 'DECIMAL arrives as a string')

  const untranslated = mapMenuItem(row, 'ku-badini')
  assert.equal(untranslated.name, 'Hummus', 'falls back for a missing language')

  const noLang = mapMenuItem(row)
  assert.equal(
    noLang.name,
    'Hummus',
    'with no lang the fallback wins — this is what keeps the merchant editor ' +
      'showing the original rather than a translation it would save back over',
  )
})

test('mapMenuItem: pre-migration rows default sensibly', () => {
  const bare = mapMenuItem({ id: 2, name: 'Tea', price: '1000' })
  assert.equal(bare.availability, 'available')
  assert.equal(bare.stock, null, 'null stock means untracked, not zero')
  assert.equal(bare.originalPrice, null)
  assert.deepEqual(bare.variants, [])
  assert.deepEqual(bare.images, [])
})

test('groupMenu: nests products under categories and preserves order', () => {
  const categories = [
    { id: 1, name: 'Appetizers', name_i18n: '{"ar":"مقبلات"}' },
    { id: 2, name: 'Drinks', name_i18n: null },
  ]
  const products = [
    { id: 10, category_id: 1, name: 'Hummus', price: '5000' },
    { id: 11, category_id: 2, name: 'Tea', price: '1000' },
    { id: 12, category_id: 99, name: 'Orphan', price: '1' },
  ]

  const grouped = groupMenu(categories, products, 'ar')
  assert.equal(grouped.length, 2)
  assert.equal(grouped[0].name, 'مقبلات')
  assert.equal(grouped[1].name, 'Drinks', 'untranslated category falls back')
  assert.equal(grouped[0].items.length, 1)
  assert.equal(grouped[1].items.length, 1)
  assert.equal(
    grouped.flatMap((c) => c.items).find((i) => i.name === 'Orphan'),
    undefined,
    'a product pointing at a missing category is dropped, not crashed on',
  )
})

test('normalizeI18n keeps only the supported languages', () => {
  assert.deepEqual(SUPPORTED_LANGS, ['en', 'ar', 'ku-badini'])
  assert.deepEqual(normalizeI18n({ ar: 'حمص', fr: 'Houmous', xx: 'x' }), { ar: 'حمص' })
})

test('normalizeI18n trims, and treats a blank as absent', () => {
  // pickI18n already ignores blanks when reading, so storing one would be a
  // value that can never be read back.
  assert.deepEqual(normalizeI18n({ ar: '  حمص  ' }), { ar: 'حمص' })
  assert.equal(normalizeI18n({ ar: '' }), null)
  assert.equal(normalizeI18n({ ar: '   ' }), null)
  assert.deepEqual(normalizeI18n({ ar: 'حمص', en: '' }), { ar: 'حمص' }, 'blank dropped, rest kept')
})

test('normalizeI18n returns null rather than an empty object', () => {
  // null is what the column stores for "no translations"; {} would be a value
  // that reads back as nothing.
  assert.equal(normalizeI18n({}), null)
  assert.equal(normalizeI18n(null), null)
  assert.equal(normalizeI18n(undefined), null)
  assert.equal(normalizeI18n('string'), null)
  assert.equal(normalizeI18n(['array']), null)
})

test('normalizeI18n ignores non-string values', () => {
  assert.equal(normalizeI18n({ ar: 42, en: null, 'ku-badini': {} }), null)
})

test('normalizeI18n output round-trips through pickI18n', () => {
  // The write and read halves have to agree, or a saved translation silently
  // never appears on the storefront.
  const stored = normalizeI18n({ ar: 'حمص', en: '  ', 'ku-badini': 'حومس' })
  assert.equal(pickI18n(stored, 'Hummus', 'ar'), 'حمص')
  assert.equal(pickI18n(stored, 'Hummus', 'ku-badini'), 'حومس')
  assert.equal(pickI18n(stored, 'Hummus', 'en'), 'Hummus', 'blank fell back')
})

test('storefront theme: a known key passes, anything else is the classic design', () => {
  assert.deepEqual(STOREFRONT_THEMES, ['classic', 'royal', 'modern'])
  assert.equal(normalizeStorefrontTheme('royal'), 'royal')
  assert.equal(normalizeStorefrontTheme('modern'), 'modern')
  assert.equal(normalizeStorefrontTheme('<script>'), 'classic')
  assert.equal(normalizeStorefrontTheme(null), 'classic')
  // Before db:add-storefront-theme the column is absent: existing stores keep
  // the design they always had.
  assert.equal(mapProfile(1, {}).storefrontTheme, 'classic')
  assert.equal(mapProfile(1, { storefront_theme: 'modern' }).storefrontTheme, 'modern')
})
