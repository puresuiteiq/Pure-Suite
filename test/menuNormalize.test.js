import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AVAILABILITY,
  normalizeAvailability,
  normalizeOriginalPrice,
  normalizeAge,
  normalizeAgeRange,
  hexColor,
  normalizeAttributes,
  normalizeVariants,
  normalizeStock,
  normalizeImages,
  validateItem,
  normalizeFocus,
} from '../src/utils/menuNormalize.js'

/**
 * Menu field validation.
 *
 * This is the layer between a merchant's form and the database, and its inputs
 * are strings from a browser — so the cases that matter are the malformed ones.
 * Prices in particular: IQD is whole dinars, and a NaN price reaching an
 * INSERT is a corrupted menu item rather than a rejected request.
 */

test('availability falls back to available for anything unrecognised', () => {
  for (const value of AVAILABILITY) assert.equal(normalizeAvailability(value), value)
  assert.equal(normalizeAvailability('sold'), 'available')
  assert.equal(normalizeAvailability(undefined), 'available')
  assert.equal(normalizeAvailability(null), 'available')
})

test('originalPrice: blank means "no discount", not zero', () => {
  // A zero "was" price would render as a 100% discount on the storefront.
  assert.equal(normalizeOriginalPrice(''), null)
  assert.equal(normalizeOriginalPrice(null), null)
  assert.equal(normalizeOriginalPrice(undefined), null)
  assert.equal(normalizeOriginalPrice('8000'), 8000)
  assert.equal(normalizeOriginalPrice(0), 0)
  assert.equal(normalizeOriginalPrice(-1), null, 'negative is not a price')
  assert.equal(normalizeOriginalPrice('abc'), null)
})

test('age bounds accept only a sane whole number of years', () => {
  assert.equal(normalizeAge('15'), 15)
  assert.equal(normalizeAge(15.4), 15, 'rounded')
  assert.equal(normalizeAge(''), null)
  assert.equal(normalizeAge(-1), null)
  assert.equal(normalizeAge(151), null, 'above the cap')
  assert.equal(normalizeAge('abc'), null)
})

test('an age range given backwards is swapped, not rejected', () => {
  assert.deepEqual(normalizeAgeRange(15, 40), { min: 15, max: 40 })
  assert.deepEqual(normalizeAgeRange(40, 15), { min: 15, max: 40 }, 'swapped')
  assert.deepEqual(normalizeAgeRange('', ''), { min: null, max: null })
  assert.deepEqual(normalizeAgeRange(10, ''), { min: 10, max: null }, 'open-ended is valid')
})

test('hexColor accepts only real hex, lowercased', () => {
  assert.equal(hexColor('#AABBCC'), '#aabbcc')
  assert.equal(hexColor('  #abc  '), '#abc')
  assert.equal(hexColor('red'), null)
  assert.equal(hexColor('#12345'), null)
  assert.equal(hexColor(''), null)
  assert.equal(hexColor(null), null)
  assert.equal(
    hexColor('#fff; background:url(x)'),
    null,
    'no arbitrary string reaches an inline style',
  )
})

test('attribute groups are trimmed, deduped and capped', () => {
  const groups = normalizeAttributes([
    { name: '  Size  ', values: [' S ', 'M', 'M', '', null, 'L'] },
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, 'Size')
  assert.deepEqual(groups[0].values, ['S', 'M', 'L'], 'deduped, trimmed, blanks dropped')
})

test('attribute groups without a name or values are dropped', () => {
  assert.deepEqual(normalizeAttributes([{ name: '', values: ['S'] }]), [])
  assert.deepEqual(normalizeAttributes([{ name: 'Size', values: [] }]), [])
  assert.deepEqual(normalizeAttributes('nonsense'), [])
  assert.deepEqual(normalizeAttributes(null), [])
})

test('attribute colours survive only for values that exist', () => {
  const [group] = normalizeAttributes([
    { name: 'Colour', values: ['Red', 'Blue'], colors: { Red: '#f00', Gone: '#0f0', Blue: 'notahex' } },
  ])
  assert.deepEqual(group.colors, { Red: '#f00' }, 'orphaned and invalid colours dropped')
})

test('attribute groups and values are capped', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ name: `G${i}`, values: ['x'] }))
  assert.equal(normalizeAttributes(many).length, 6, 'at most 6 groups')

  const wide = [{ name: 'G', values: Array.from({ length: 60 }, (_, i) => `v${i}`) }]
  assert.equal(normalizeAttributes(wide)[0].values.length, 40, 'at most 40 values')
})

test('variants: an incomplete row rejects the whole set', () => {
  // Partial acceptance would leave a product priced by options where one option
  // has no price.
  assert.deepEqual(normalizeVariants([]), { variants: [], error: null })
  assert.deepEqual(normalizeVariants(null), { variants: [], error: null })

  const ok = normalizeVariants([{ value: ' Large ', price: '9000' }])
  assert.equal(ok.error, null)
  assert.deepEqual(ok.variants, [{ value: 'Large', price: 9000 }])

  assert.ok(normalizeVariants([{ value: '', price: 9000 }]).error, 'no name')
  assert.ok(normalizeVariants([{ value: 'L', price: 'abc' }]).error, 'NaN price')
  assert.ok(normalizeVariants([{ value: 'L', price: -1 }]).error, 'negative price')
})

test('variants tolerate the pre-migration size_name field', () => {
  const { variants } = normalizeVariants([{ size_name: 'Large', price: 9000 }])
  assert.deepEqual(variants, [{ value: 'Large', price: 9000 }])
})

test('stock distinguishes untracked from zero', () => {
  // null means "inventory not tracked" — every restaurant item. 0 means
  // "tracked and sold out". Conflating them would either block restaurant
  // orders or let stores oversell.
  assert.deepEqual(normalizeStock(null), { stock: null, error: null })
  assert.deepEqual(normalizeStock(''), { stock: null, error: null })
  assert.deepEqual(normalizeStock(0), { stock: 0, error: null })
  assert.deepEqual(normalizeStock('7'), { stock: 7, error: null })

  assert.ok(normalizeStock(-1).error, 'negative')
  assert.ok(normalizeStock(1.5).error, 'fractional')
  assert.ok(normalizeStock('abc').error)
})

test('images keep only non-empty strings', () => {
  assert.deepEqual(normalizeImages(['a', '', null, 7, 'b']), ['a', 'b'])
  assert.deepEqual(normalizeImages(null), [])
  assert.deepEqual(normalizeImages('a'), [], 'a bare string is not a gallery')
})

test('an item needs a name, and a price unless priced by variants', () => {
  assert.equal(validateItem({ name: 'Tea', price: 1000, variants: [] }), null)
  assert.ok(validateItem({ name: '   ', price: 1000, variants: [] }), 'blank name')
  assert.ok(validateItem({ name: 'Tea', price: 'abc', variants: [] }), 'NaN price')
  assert.ok(validateItem({ name: 'Tea', price: -5, variants: [] }), 'negative price')
  assert.equal(
    validateItem({ name: 'Tea', price: '', variants: [{ value: 'L', price: 1 }] }),
    null,
    'variants supply the price, so the base price is not required',
  )
})

test('normalizeFocus: stores the dragged point as rounded, clamped percentages', () => {
  assert.equal(normalizeFocus({ x: 50, y: 20 }), '50 20')
  assert.equal(normalizeFocus({ x: 33.6, y: 0.4 }), '34 0')
  assert.equal(normalizeFocus({ x: -10, y: 140 }), '0 100')
  // Not set, or not numbers: the card keeps its own default framing.
  assert.equal(normalizeFocus(null), null)
  assert.equal(normalizeFocus({ x: 'left', y: 10 }), null)
  assert.equal(normalizeFocus('50 50'), null)
})
