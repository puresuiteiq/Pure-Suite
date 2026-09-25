/**
 * Serving stored images as real image responses.
 *
 * Images live in MEDIUMTEXT columns as data URLs. Sent inside JSON they are
 * downloaded whether or not anything displays them; served from their own URL,
 * the browser lazy-loads and caches each one separately.
 */

/**
 * The `v` query value for an image URL: the row's updated_at, in seconds.
 *
 * It changes whenever the row is edited, which is what allows the bytes to be
 * cached for a year — an edited image is a different URL, so a cached copy can
 * never be stale.
 */
export const imageVersion = (updatedAt) =>
  updatedAt ? Math.floor(new Date(updatedAt).getTime() / 1000) : 0

/** Split a stored data URL into a servable buffer + content type. */
export function decodeDataUrl(value) {
  if (typeof value !== 'string') return null
  const match = /^data:([\w/+.-]+);base64,(.*)$/s.exec(value)
  if (!match) return null
  try {
    return { contentType: match[1], body: Buffer.from(match[2], 'base64') }
  } catch {
    return null
  }
}

/**
 * Send an image with caching that makes it a one-time download.
 *
 * Safe to mark immutable because every URL built for these endpoints carries
 * imageVersion(). `scope: 'private'` is for images only their own merchant may
 * fetch, so a shared proxy never keeps a copy.
 */
export function sendImage(res, stored, { scope = 'public', cacheControl = null } = {}) {
  const decoded = decodeDataUrl(stored)
  if (!decoded) {
    // A CDN/remote URL was stored rather than a data URL: hand the client
    // straight to it instead of trying to proxy bytes we do not have.
    if (typeof stored === 'string' && /^https?:\/\//.test(stored)) {
      return res.redirect(302, stored)
    }
    return res.status(404).json({ status: 'error', error: 'Image not found' })
  }
  res.set('Content-Type', decoded.contentType)
  // `cacheControl` is for a URL that is NOT versioned (the platform logo in
  // index.html's share-card tags), which must not be pinned for a year.
  res.set('Cache-Control', cacheControl || `${scope}, max-age=31536000, immutable`)
  // These URLs get opened directly, not only through <img>. For a stored SVG
  // that means a document on the app's own domain, where its script would run
  // as the app. A sandboxed, script-free policy stops that for every image
  // served here — logos and product photos included — and changes nothing
  // for <img>, which never runs an image's script anyway.
  res.set('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
  return res.send(decoded.body)
}
