import test from 'node:test'
import assert from 'node:assert/strict'

// Imported dynamically so NODE_ENV is set before config/auth.js reads it.
process.env.NODE_ENV ||= 'test'
const { default: app } = await import('../src/app.js')

/**
 * The one test that loads the real app, because these headers only exist there.
 *
 * Helmet's default Referrer-Policy (no-referrer) once blanked the merchant
 * location map on production: OpenStreetMap refuses tile requests that carry
 * no Referer. Vite's dev server sends no such header, so only the Express app
 * can catch this.
 */
test('referrer policy lets map tiles see our origin without leaking paths', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/csrf-token`)
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')

  // The rest of Helmet's baseline must survive the change.
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.ok(res.headers.get('strict-transport-security'), 'HSTS still sent')
})
