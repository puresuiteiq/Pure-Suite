import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RANGE_UNSATISFIABLE,
  SPLASH_MAX_BYTES,
  SPLASH_TAGLINE_MAX,
  checkSplashUpload,
  mapSplash,
  normalizeSplashTagline,
  parseRange,
  sniffSplashMedia,
} from '../src/utils/splash.js'

/**
 * Storefront welcome-screen rules.
 *
 * The media is served from the app's own domain to anyone, so what it *is*
 * comes from its bytes, never the upload's Content-Type. And a phone plays the
 * video only through byte ranges, so the range maths decides whether it plays.
 */

const pad = (head) => Buffer.concat([head, Buffer.alloc(32)])
const ftyp = (brand) => pad(Buffer.from([0, 0, 0, 0x20, ...Buffer.from(`ftyp${brand}`)]))

test('sniffSplashMedia recognises pictures by their signature', () => {
  assert.equal(sniffSplashMedia(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).contentType, 'image/jpeg')
  assert.equal(sniffSplashMedia(pad(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).contentType, 'image/png')
  assert.equal(sniffSplashMedia(pad(Buffer.from('GIF89a'))).contentType, 'image/gif')
  assert.equal(sniffSplashMedia(pad(Buffer.from('RIFF\0\0\0\0WEBP'))).contentType, 'image/webp')
  assert.equal(sniffSplashMedia(ftyp('avif')).kind, 'image')
})

test('sniffSplashMedia stores every MP4-family container, iPhone .mov included, as video/mp4', () => {
  for (const brand of ['isom', 'mp42', 'M4V ', 'qt  ']) {
    assert.deepEqual(sniffSplashMedia(ftyp(brand)), { contentType: 'video/mp4', kind: 'video' })
  }
  assert.deepEqual(sniffSplashMedia(pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))), {
    contentType: 'video/webm',
    kind: 'video',
  })
})

test('sniffSplashMedia refuses what a storefront cannot show safely or at all', () => {
  assert.equal(sniffSplashMedia(pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))), null)
  assert.equal(sniffSplashMedia(pad(Buffer.from('<!doctype html><script>'))), null)
  assert.equal(sniffSplashMedia(ftyp('heic')), null)
  assert.equal(sniffSplashMedia(Buffer.from([0xff, 0xd8])), null) // too short to be anything
  assert.equal(sniffSplashMedia('not a buffer'), null)
})

test('checkSplashUpload applies the limit for the kind the bytes actually are', () => {
  const bigImage = Buffer.alloc(SPLASH_MAX_BYTES.image + 1)
  bigImage.set([0xff, 0xd8, 0xff])
  assert.deepEqual(checkSplashUpload(bigImage), {
    error: 'SPLASH_MEDIA_TOO_LARGE',
    params: { max: 5 },
  })

  // The same size is fine for a video.
  const video = Buffer.alloc(SPLASH_MAX_BYTES.image + 1)
  video.set(ftyp('isom').subarray(0, 12))
  assert.equal(checkSplashUpload(video).media.kind, 'video')

  assert.equal(checkSplashUpload(Buffer.alloc(0)).error, 'SPLASH_MEDIA_INVALID')
  assert.equal(checkSplashUpload(undefined).error, 'SPLASH_MEDIA_INVALID')
})

test('parseRange serves a browser starting a video a capped first slice', () => {
  assert.deepEqual(parseRange('bytes=0-', 10_000_000, 1000), { start: 0, end: 999 })
  assert.deepEqual(parseRange('bytes=9999500-', 10_000_000, 1000), { start: 9999500, end: 9999999 })
})

test('parseRange honours explicit and suffix ranges, clamped to the file', () => {
  assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 })
  assert.deepEqual(parseRange('bytes=50-5000', 100), { start: 50, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 })
})

test('parseRange falls back to the whole file for anything it does not handle', () => {
  assert.equal(parseRange(undefined, 100), null)
  assert.equal(parseRange('bytes=0-10,20-30', 100), null)
  assert.equal(parseRange('items=0-10', 100), null)
  assert.equal(parseRange('bytes=-', 100), null)
})

test('parseRange reports a range outside the file as unsatisfiable', () => {
  assert.equal(parseRange('bytes=100-', 100), RANGE_UNSATISFIABLE)
  assert.equal(parseRange('bytes=50-10', 100), RANGE_UNSATISFIABLE)
  assert.equal(parseRange('bytes=-0', 100), RANGE_UNSATISFIABLE)
})

test('normalizeSplashTagline trims, caps and stores blank as null', () => {
  assert.equal(normalizeSplashTagline('  Fresh bread daily  '), 'Fresh bread daily')
  assert.equal(normalizeSplashTagline('   '), null)
  assert.equal(normalizeSplashTagline(42), null)
  assert.equal(normalizeSplashTagline('x'.repeat(500)).length, SPLASH_TAGLINE_MAX)
})

test('mapSplash defaults to off with no media on a database without the columns', () => {
  assert.deepEqual(mapSplash({}, null, () => 'unused'), {
    splashEnabled: false,
    splashTagline: '',
    splashMedia: null,
  })
})

test('mapSplash builds a versioned URL and names the media kind', () => {
  const url = (updatedAt) => `/media?v=${updatedAt}`
  const row = { splash_enabled: 1, splash_tagline: 'Hi' }
  assert.deepEqual(mapSplash(row, { content_type: 'video/mp4', updated_at: 7 }, url), {
    splashEnabled: true,
    splashTagline: 'Hi',
    splashMedia: { url: '/media?v=7', kind: 'video' },
  })
  assert.equal(mapSplash(row, { content_type: 'image/webp', updated_at: 7 }, url).splashMedia.kind, 'image')
})
