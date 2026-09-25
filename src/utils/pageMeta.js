/**
 * Link-preview ("share card") tags for the HTML pages the API serves.
 *
 * Facebook, WhatsApp, Telegram and the rest never run JavaScript: they read
 * the page's HTML once and build the card from its Open Graph tags. The app is
 * a single-page app whose index.html is the same file for every URL, so without
 * this every shared storefront link previewed as the platform, never the store.
 *
 * Pure (no database), so what a shared link turns into is unit-tested.
 */

export const META_START = '<!-- page-meta -->'
export const META_END = '<!-- /page-meta -->'

/** Longest description kept; the cards cut around here anyway. */
export const DESCRIPTION_MAX = 200

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** One line, trimmed, cut at a word where possible. */
export function shortText(value, max = DESCRIPTION_MAX) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The <title> plus Open Graph / Twitter tags, between the markers. */
export function pageMetaTags({ title, description, url, image, siteName }) {
  const tag = (attr, key, value) =>
    value ? `    <meta ${attr}="${key}" content="${escapeHtml(value)}" />` : null
  return [
    META_START,
    `    <title>${escapeHtml(title)}</title>`,
    tag('name', 'description', description),
    tag('property', 'og:type', 'website'),
    tag('property', 'og:site_name', siteName),
    tag('property', 'og:title', title),
    tag('property', 'og:description', description),
    tag('property', 'og:url', url),
    tag('property', 'og:image', image),
    tag('name', 'twitter:card', image ? 'summary' : null),
    tag('name', 'twitter:title', title),
    tag('name', 'twitter:description', description),
    tag('name', 'twitter:image', image),
    `    ${META_END}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Put the tags into index.html: replacing the build's own marked block when it
 * has one, otherwise replacing <title> and adding the rest before </head> — so
 * an index.html built before the markers existed still gets a card.
 */
export function injectPageMeta(html, tags) {
  const start = html.indexOf(META_START)
  const end = html.indexOf(META_END)
  if (start !== -1 && end > start) {
    return html.slice(0, start) + tags + html.slice(end + META_END.length)
  }
  const withoutTitle = html.replace(/<title>[\s\S]*?<\/title>/i, '')
  return withoutTitle.replace(/<\/head>/i, `${tags}\n  </head>`)
}

/**
 * What a shared storefront link says: the store's name, its own description
 * (or welcome-screen tagline), and its logo.
 */
export function storefrontMeta(row, { siteName, url, image }) {
  const name = String(row?.business_name ?? '').trim() || siteName
  const description =
    shortText(row?.description) ||
    shortText(row?.splash_tagline) ||
    `${name} — تصفّح القائمة واطلب مباشرة عبر واتساب`
  return { title: name, description, url, image, siteName }
}
