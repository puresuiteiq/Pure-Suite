import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_BANNERS,
  BANNER_TITLE_MAX,
  isBannerImage,
  normalizeBannerInput,
  linkTargetSets,
  groupLinkTargets,
  mapBanner,
} from '../src/utils/banners.js'
import { mapProfile } from '../src/utils/mappers.js'

/**
 * Storefront banner rules.
 *
 * Two of these protect customers rather than the database: a banner is nothing
 * but its image, so a non-image must never be stored as a slide; and a link to
 * a product or category deleted since must read back as no link, or tapping
 * the slide opens nothing.
 */

const IMAGE = 'data:image/webp;base64,UklGRg=='

test('MAX_BANNERS: every merchant may have up to 15', () => {
  assert.equal(MAX_BANNERS, 15)
})

test('isBannerImage: accepts uploaded raster images only', () => {
  assert.equal(isBannerImage(IMAGE), true)
  assert.equal(isBannerImage('data:image/jpeg;base64,/9j/4AAQ'), true)
  // Banners are uploaded from the merchant's device, never linked.
  assert.equal(isBannerImage('https://cdn.example.com/banner.jpg'), false)
  assert.equal(isBannerImage('http://example.com/banner.png'), false)
  // Served publicly from the app's own domain, an SVG's script would run as
  // the app when the image URL is opened directly.
  assert.equal(isBannerImage('data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4='), false)
  assert.equal(isBannerImage('data:text/html;base64,PGgxPg=='), false, 'not an image type')
  assert.equal(isBannerImage('data:image/png;base64,'), false, 'no payload')
  assert.equal(isBannerImage('javascript:alert(1)'), false)
  assert.equal(isBannerImage(''), false)
  assert.equal(isBannerImage(null), false)
})

test('normalizeBannerInput: a new banner needs an image', () => {
  assert.deepEqual(normalizeBannerInput({}), { error: 'BANNER_IMAGE_REQUIRED' })
  assert.deepEqual(normalizeBannerInput(null), { error: 'BANNER_IMAGE_REQUIRED' })
  assert.deepEqual(normalizeBannerInput([IMAGE]), { error: 'BANNER_IMAGE_REQUIRED' })
})

test('normalizeBannerInput: a new banner gets defaults for everything else', () => {
  assert.deepEqual(normalizeBannerInput({ image: IMAGE }), {
    fields: { image: IMAGE, title: null, linkType: 'none', linkId: null, isActive: true },
  })
  assert.equal(normalizeBannerInput({ image: IMAGE, isActive: false }).fields.isActive, false)
})

test('normalizeBannerInput: the title is trimmed and capped; blank means none', () => {
  const long = 'x'.repeat(BANNER_TITLE_MAX + 20)
  assert.equal(
    normalizeBannerInput({ image: IMAGE, title: `  ${long}  ` }).fields.title.length,
    BANNER_TITLE_MAX,
  )
  assert.equal(normalizeBannerInput({ image: IMAGE, title: '   ' }).fields.title, null)
  assert.equal(normalizeBannerInput({ image: IMAGE, title: 42 }).fields.title, null)
})

test('normalizeBannerInput: a link needs a real id; an unknown kind is no link', () => {
  const linked = normalizeBannerInput({ image: IMAGE, linkType: 'product', linkId: '7' }).fields
  assert.deepEqual([linked.linkType, linked.linkId], ['product', 7])

  assert.deepEqual(normalizeBannerInput({ image: IMAGE, linkType: 'product' }), {
    error: 'BANNER_LINK_INVALID',
  })
  assert.deepEqual(normalizeBannerInput({ image: IMAGE, linkType: 'category', linkId: -1 }), {
    error: 'BANNER_LINK_INVALID',
  })

  const unknown = normalizeBannerInput({ image: IMAGE, linkType: 'website', linkId: 7 }).fields
  assert.deepEqual([unknown.linkType, unknown.linkId], ['none', null])
})

test('normalizeBannerInput: a partial update carries only what was sent', () => {
  // Switching a slide off must not resend — or re-version — its image.
  assert.deepEqual(normalizeBannerInput({ isActive: false }, { partial: true }), {
    fields: { isActive: false },
  })
  assert.deepEqual(normalizeBannerInput({ title: 'Offer' }, { partial: true }), {
    fields: { title: 'Offer' },
  })
  assert.deepEqual(normalizeBannerInput({}, { partial: true }), { fields: {} })
  assert.deepEqual(normalizeBannerInput({ image: 'nope' }, { partial: true }), {
    error: 'BANNER_IMAGE_REQUIRED',
  })
})

test('mapBanner: builds the image URL and normalises the flag', () => {
  const row = {
    id: 3,
    title: 'Offer',
    link_type: 'none',
    link_id: null,
    is_active: 0,
    updated_at: '2026-01-01',
  }
  assert.deepEqual(mapBanner(row, { imageUrl: (id, v) => `/img/${id}?v=${v}` }), {
    id: 3,
    image: '/img/3?v=2026-01-01',
    title: 'Offer',
    linkType: 'none',
    linkId: null,
    isActive: false,
  })
  assert.equal(mapBanner({ ...row, is_active: null }).isActive, true, 'a missing flag reads as shown')
  assert.equal(mapBanner(row).image, null, 'no URL builder, no image')
})

test('mapBanner: a link to something since deleted reads back as no link', () => {
  const linkTargets = linkTargetSets([{ id: 1 }], [{ id: 10 }])

  const live = mapBanner({ id: 1, link_type: 'product', link_id: 10 }, { linkTargets })
  assert.deepEqual([live.linkType, live.linkId], ['product', 10])

  const gone = mapBanner({ id: 1, link_type: 'product', link_id: 99 }, { linkTargets })
  assert.deepEqual([gone.linkType, gone.linkId], ['none', null])

  const wrongKind = mapBanner({ id: 1, link_type: 'category', link_id: 10 }, { linkTargets })
  assert.deepEqual([wrongKind.linkType, wrongKind.linkId], ['none', null], 'a product id is not a category')

  const unchecked = mapBanner({ id: 1, link_type: 'category', link_id: 5 })
  assert.equal(unchecked.linkType, 'category', 'without targets, the stored link stands')
})

test('groupLinkTargets: nests products under their category, names only', () => {
  const grouped = groupLinkTargets(
    [
      { id: 1, name: 'Sandwiches' },
      { id: 2, name: 'Drinks' },
    ],
    [
      { id: 10, category_id: 1, name: 'Falafel', image: 'data:image/png;base64,AAAA' },
      { id: 11, category_id: 9, name: 'Orphan' },
    ],
  )
  assert.deepEqual(grouped, [
    { id: 1, name: 'Sandwiches', items: [{ id: 10, name: 'Falafel' }] },
    { id: 2, name: 'Drinks', items: [] },
  ])
})

test('mapProfile: showBanner defaults on, including before its column exists', () => {
  assert.equal(mapProfile(1, {}).showBanner, true)
  assert.equal(mapProfile(1, { show_banner: null }).showBanner, true)
  assert.equal(mapProfile(1, { show_banner: 0 }).showBanner, false)
  assert.equal(mapProfile(1, { show_banner: 1 }).showBanner, true)
})
