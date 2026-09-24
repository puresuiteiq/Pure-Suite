import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeDataUrl, imageVersion, sendImage } from '../src/utils/imageResponse.js'

/**
 * Serving stored images.
 *
 * The part worth pinning is the headers. These URLs are public, cached for a
 * year and opened directly as well as through <img> — so an image response must
 * never be able to run script on the app's domain, and a merchant-only image
 * must never land in a shared cache.
 */

function fakeRes() {
  const res = { headers: {}, statusCode: 200, body: undefined, redirectedTo: null }
  res.set = (name, value) => ((res.headers[name.toLowerCase()] = value), res)
  res.status = (code) => ((res.statusCode = code), res)
  res.json = (body) => ((res.body = body), res)
  res.send = (body) => ((res.body = body), res)
  res.redirect = (code, url) => ((res.statusCode = code), (res.redirectedTo = url), res)
  return res
}

const PNG = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64')}`

test('sendImage: serves the decoded bytes with a year of public caching', () => {
  const res = fakeRes()
  sendImage(res, PNG)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.equal(res.body.toString(), 'png-bytes')
})

test('sendImage: every image is sandboxed with no script allowed', () => {
  // A stored SVG opened directly is a document on the app's own domain.
  const res = fakeRes()
  sendImage(res, SVG)
  const csp = res.headers['content-security-policy']
  assert.ok(csp, 'a Content-Security-Policy is set')
  assert.match(csp, /\bsandbox\b/)
  assert.match(csp, /default-src 'none'/)
  assert.doesNotMatch(csp, /script-src/, 'nothing re-allows script')
})

test('sendImage: merchant-only images are never publicly cacheable', () => {
  const res = fakeRes()
  sendImage(res, PNG, { scope: 'private' })
  assert.match(res.headers['cache-control'], /^private,/)
})

test('sendImage: a stored http(s) URL redirects; anything else is a 404', () => {
  const redirect = fakeRes()
  sendImage(redirect, 'https://cdn.example.com/a.jpg')
  assert.equal(redirect.statusCode, 302)
  assert.equal(redirect.redirectedTo, 'https://cdn.example.com/a.jpg')

  for (const stored of [null, '', 'not an image', 'javascript:alert(1)']) {
    const res = fakeRes()
    sendImage(res, stored)
    assert.equal(res.statusCode, 404, `stored value ${JSON.stringify(stored)}`)
  }
})

test('decodeDataUrl and imageVersion', () => {
  assert.equal(decodeDataUrl('nope'), null)
  assert.equal(decodeDataUrl(PNG).contentType, 'image/png')
  assert.equal(imageVersion('2026-01-01T00:00:10Z'), 1767225610)
  assert.equal(imageVersion(null), 0)
})
