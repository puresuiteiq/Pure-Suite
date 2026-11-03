import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasPhotoCondition,
  imageFlagColumns,
  productListColumns,
} from '../src/utils/productImageColumns.js'

const MIGRATED = ['id', 'name', 'image', 'images', 'has_image', 'image_count']
const OLD = ['id', 'name', 'image', 'images']

test('migrated schema reads the stored flags, never the blobs', () => {
  const sql = productListColumns(MIGRATED, 'p')
  assert.equal(sql, 'p.`id`, p.`name`, p.`has_image`, p.`image_count`')
  assert.doesNotMatch(sql, /CHAR_LENGTH|JSON_LENGTH|`image`|`images`/)
  assert.equal(hasPhotoCondition(MIGRATED, 'cp'), '(cp.`has_image` = 1 OR cp.`image_count` > 0)')
})

test('un-migrated schema falls back to computing the flags', () => {
  assert.deepEqual(imageFlagColumns(OLD), [
    'CHAR_LENGTH(`image`) > 0 AS has_image',
    'COALESCE(JSON_LENGTH(`images`), 0) AS image_count',
  ])
  assert.equal(
    hasPhotoCondition(OLD, 'cp'),
    '(CHAR_LENGTH(cp.`image`) > 0 OR COALESCE(JSON_LENGTH(cp.`images`), 0) > 0)',
  )
})

test('no image columns at all', () => {
  assert.equal(productListColumns(['id']), '`id`, 0 AS has_image, 0 AS image_count')
  assert.equal(hasPhotoCondition(['id']), '0')
  assert.equal(productListColumns([]), '*')
})
