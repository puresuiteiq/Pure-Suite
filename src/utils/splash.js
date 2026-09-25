/**
 * Storefront welcome screen ("splash"): the rules for its background media and
 * the byte-range maths that serves it.
 *
 * Pure (no database), so what a merchant may upload and what a phone is sent
 * are unit-tested directly.
 */

/** Matches merchants.splash_tagline. */
export const SPLASH_TAGLINE_MAX = 160

/**
 * Upload ceilings. The image ceiling is generous because the panel downscales
 * before uploading; the video one is what a short, phone-shot loop needs while
 * staying inside a default MySQL max_allowed_packet (64 MB on MySQL 8).
 */
export const SPLASH_MAX_BYTES = {
  image: 5 * 1024 * 1024,
  video: 10 * 1024 * 1024,
}

/**
 * The largest slice sent for an open-ended range ("bytes=N-", which is what
 * every browser asks for when it starts a video). Without a cap the first
 * request would read the entire file out of MySQL before playback began.
 */
export const SPLASH_RANGE_CHUNK = 2 * 1024 * 1024

/**
 * What the bytes actually are, from their signature — never from the
 * Content-Type the browser sent, which is only a claim.
 *
 * Every ISO base-media container (MP4, M4V and an iPhone's QuickTime .mov) is
 * stored as video/mp4: browsers play H.264 in any of them when told it is MP4,
 * but Chrome refuses the very same file labelled video/quicktime.
 *
 * Not SVG, for the same reason banners refuse it: it can carry script.
 */
export function sniffSplashMedia(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  const ascii = (start, end) => buffer.toString('latin1', start, end)

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { contentType: 'image/jpeg', kind: 'image' }
  }
  if (buffer.readUInt32BE(0) === 0x89504e47) return { contentType: 'image/png', kind: 'image' }
  if (ascii(0, 4) === 'GIF8') return { contentType: 'image/gif', kind: 'image' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return { contentType: 'image/webp', kind: 'image' }
  }
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    // AVIF/HEIC share the container; they are pictures, not video.
    if (brand === 'avif' || brand === 'avis') return { contentType: 'image/avif', kind: 'image' }
    if (/^hei|^mif1|^msf1/.test(brand)) return null // HEIC: no browser outside Safari shows it
    return { contentType: 'video/mp4', kind: 'video' }
  }
  if (buffer.readUInt32BE(0) === 0x1a45dfa3) return { contentType: 'video/webm', kind: 'video' }
  return null
}

/**
 * Validate an upload. Returns `{ media }` (`{ contentType, kind }`) or
 * `{ error }` holding an ERROR_CODES key, plus `params` for the message.
 */
export function checkSplashUpload(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { error: 'SPLASH_MEDIA_INVALID' }
  const media = sniffSplashMedia(buffer)
  if (!media) return { error: 'SPLASH_MEDIA_INVALID' }
  const max = SPLASH_MAX_BYTES[media.kind]
  if (buffer.length > max) {
    return { error: 'SPLASH_MEDIA_TOO_LARGE', params: { max: Math.round(max / (1024 * 1024)) } }
  }
  return { media }
}

/** A tagline for storage: trimmed, capped, and null when blank. */
export function normalizeSplashTagline(value) {
  const text = typeof value === 'string' ? value.trim().slice(0, SPLASH_TAGLINE_MAX) : ''
  return text || null
}

export const RANGE_UNSATISFIABLE = 'unsatisfiable'

/**
 * Parse a Range header against a file of `size` bytes.
 *
 * Returns null for "send the whole file" (no header, or one this does not
 * handle, which RFC 9110 says to ignore), RANGE_UNSATISFIABLE for a range
 * wholly outside the file, or `{ start, end }` (inclusive).
 *
 * Only a single range is honoured — a multi-range request is answered with the
 * whole file, which is always a valid reply. An open-ended range is capped at
 * `chunk` bytes; the client simply asks for the next slice.
 */
export function parseRange(header, size, chunk = SPLASH_RANGE_CHUNK) {
  if (typeof header !== 'string' || !size) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  let start
  let end
  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd)
    if (suffix === 0) return RANGE_UNSATISFIABLE
    start = Math.max(size - suffix, 0)
    end = size - 1
  } else {
    start = Number(rawStart)
    if (start >= size) return RANGE_UNSATISFIABLE
    end = rawEnd === '' ? Math.min(start + chunk - 1, size - 1) : Math.min(Number(rawEnd), size - 1)
    if (end < start) return RANGE_UNSATISFIABLE
  }
  return { start, end }
}

/**
 * The welcome-screen part of a merchant row plus its media row, as the API
 * sends it.
 *
 * `media` is `{ content_type, updated_at }` or null; `mediaUrl(updatedAt)`
 * builds its URL. The bytes are never in either row.
 */
export function mapSplash(row, media, mediaUrl) {
  return {
    splashEnabled: row?.splash_enabled == null ? false : Boolean(row.splash_enabled),
    splashTagline: row?.splash_tagline ?? '',
    splashMedia: media
      ? {
          url: mediaUrl(media.updated_at),
          kind: String(media.content_type).startsWith('video/') ? 'video' : 'image',
        }
      : null,
  }
}
