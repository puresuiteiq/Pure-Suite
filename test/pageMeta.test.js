import test from 'node:test'
import assert from 'node:assert/strict'
import {
  META_END,
  META_START,
  escapeHtml,
  injectPageMeta,
  pageMetaTags,
  shortText,
  storefrontMeta,
} from '../src/utils/pageMeta.js'

/**
 * Link-preview tags. Merchant text ends up inside HTML attributes that every
 * visitor's browser parses, so escaping is the part that matters most; the
 * rest decides what a shared link actually shows.
 */

const INDEX = `<html><head>
    <meta charset="UTF-8" />
    ${META_START}
    <title>Platform</title>
    <meta property="og:title" content="Platform" />
    ${META_END}
  </head><body><div id="root"></div></body></html>`

test('escapeHtml neutralises everything that could break out of an attribute', () => {
  assert.equal(escapeHtml(`"><script>alert('x')</script>&`), '&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;')
})

test('a store name cannot inject markup into the page', () => {
  const html = injectPageMeta(
    INDEX,
    pageMetaTags({ title: '"/><script>steal()</script>', description: 'x', siteName: 'P' }),
  )
  assert.equal(html.includes('<script>steal()'), false)
  assert.ok(html.includes('&quot;/&gt;&lt;script&gt;steal()'))
})

test('injectPageMeta replaces the marked block, leaving the rest of the page', () => {
  const html = injectPageMeta(INDEX, pageMetaTags({ title: 'أفران قمحة', siteName: 'Pure Suite' }))
  assert.equal(html.match(/<title>/g).length, 1)
  assert.ok(html.includes('<title>أفران قمحة</title>'))
  assert.equal(html.includes('content="Platform"'), false)
  assert.ok(html.includes('<meta charset="UTF-8" />'))
  assert.ok(html.includes('<div id="root"></div>'))
})

test('injectPageMeta still works on an index.html built before the markers', () => {
  const old = '<html><head><title>Old</title></head><body></body></html>'
  const html = injectPageMeta(old, pageMetaTags({ title: 'New', siteName: 'P' }))
  assert.equal(html.match(/<title>/g).length, 1)
  assert.ok(html.includes('<title>New</title>'))
  assert.ok(html.indexOf('og:title') < html.indexOf('</head>'))
})

test('pageMetaTags leaves out the image tags when there is no image', () => {
  const tags = pageMetaTags({ title: 'T', description: 'D', siteName: 'S' })
  assert.equal(tags.includes('og:image'), false)
  assert.equal(tags.includes('twitter:card'), false)
  const withImage = pageMetaTags({ title: 'T', siteName: 'S', image: 'https://x/logo.png' })
  assert.ok(withImage.includes('<meta property="og:image" content="https://x/logo.png" />'))
  assert.ok(withImage.includes('<meta name="twitter:card" content="summary" />'))
})

test('storefrontMeta describes the store: its description, else its tagline, else a default', () => {
  const base = { siteName: 'Pure Suite', url: 'https://s/r/q', image: 'https://a/logo' }
  assert.equal(storefrontMeta({ business_name: 'قمحة', description: ' خبز طازج ' }, base).description, 'خبز طازج')
  assert.equal(storefrontMeta({ business_name: 'قمحة', splash_tagline: 'من الفرن' }, base).description, 'من الفرن')
  assert.match(storefrontMeta({ business_name: 'قمحة' }, base).description, /^قمحة — /)
  assert.equal(storefrontMeta({ business_name: 'قمحة' }, base).title, 'قمحة')
  assert.equal(storefrontMeta({ business_name: '' }, base).title, 'Pure Suite')
})

test('shortText keeps cards to one tidy line', () => {
  assert.equal(shortText('a\n\n b   c'), 'a b c')
  const long = shortText('word '.repeat(100), 50)
  assert.ok(long.length <= 50)
  assert.ok(long.endsWith('…'))
})
