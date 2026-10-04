import test from 'node:test'
import assert from 'node:assert/strict'
import { positionCase, reorderWithin } from '../src/utils/reorder.js'

/**
 * Drag-and-drop reordering. The editor loads a category's items in pages, so a
 * drop may describe only some of them; the rest must stay exactly where they
 * were, and nothing outside the merchant's own list may get in.
 */

test('reorderWithin: a complete new order is taken as given', () => {
  assert.deepEqual(reorderWithin([1, 2, 3], [3, 1, 2]).order, [3, 1, 2])
})

test('reorderWithin: a partial order reorders only its own slots', () => {
  // The first page (a, b, c) was reordered; d and e were never loaded.
  assert.deepEqual(reorderWithin([1, 2, 3, 4, 5], [3, 1, 2]).order, [3, 1, 2, 4, 5])
  // Non-adjacent members swap places; the others don't move.
  assert.deepEqual(reorderWithin([1, 2, 3, 4, 5], [4, 2]).order, [1, 4, 3, 2, 5])
})

test('reorderWithin: ids are compared as numbers (JSON may send strings)', () => {
  assert.deepEqual(reorderWithin([1, 2], ['2', '1']).order, [2, 1])
})

test('reorderWithin: refuses unknown, duplicated or empty orders', () => {
  assert.equal(reorderWithin([1, 2, 3], [1, 99]).error, 'invalid') // not in this list
  assert.equal(reorderWithin([1, 2, 3], [1, 1]).error, 'invalid')
  assert.equal(reorderWithin([1, 2, 3], []).error, 'invalid')
  assert.equal(reorderWithin([1, 2, 3], 'nope').error, 'invalid')
})

test('positionCase: numbers the whole order from 0', () => {
  const { sql, values } = positionCase([3, 1, 2])
  assert.equal(sql, 'CASE id WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? END')
  assert.deepEqual(values, [3, 0, 1, 1, 2, 2])
})
