import pool from '../config/db.js'
import { imageVersion } from '../utils/imageResponse.js'
import { RANGE_UNSATISFIABLE, mapSplash, parseRange } from '../utils/splash.js'

/**
 * merchant_splash_media support shared by the merchant and storefront
 * controllers.
 *
 * The media is a BLOB, not a data URL like every other image here: a video is
 * too big to travel as base64 JSON, and a phone plays it through a series of
 * byte-range requests. Each one reads only its own slice (SUBSTRING), so
 * scrubbing through a 15 MB video never pulls 15 MB out of MySQL per request.
 */

let tableExists = null

/**
 * Whether this database has the merchant_splash_media table. Cached per
 * process, like bannersAvailable(): the API creates it at boot, and a database
 * user without CREATE rights must still serve every storefront.
 */
export async function splashAvailable() {
  if (tableExists === null) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'merchant_splash_media'`,
    )
    tableExists = Number(rows[0].n) > 0
  }
  return tableExists
}

/** `{ content_type, byte_size, updated_at }` for a merchant's media, or null. */
export async function readSplashMeta(merchantId) {
  if (!(await splashAvailable())) return null
  const [rows] = await pool.query(
    'SELECT content_type, byte_size, updated_at FROM merchant_splash_media WHERE merchant_id = ?',
    [merchantId],
  )
  return rows[0] ?? null
}

/** The splash fields for a profile response, media URL included. */
export async function splashFields(merchantId, row, mediaUrl) {
  return mapSplash(row, await readSplashMeta(merchantId), mediaUrl)
}

/** Versioned URL builders — see imageVersion() for why they can be cached for a year. */
export const mySplashMediaUrl = (updatedAt) =>
  `/api/merchant/splash/media?v=${imageVersion(updatedAt)}`

export const publicSplashMediaUrl = (merchantParam) => (updatedAt) =>
  `/api/public/merchants/${encodeURIComponent(merchantParam)}/splash?v=${imageVersion(updatedAt)}`

/** Insert or replace a merchant's media. Prepared, so the bytes go over the wire as binary, not hex. */
export async function storeSplashMedia(merchantId, buffer, contentType) {
  await pool.execute(
    `INSERT INTO merchant_splash_media (merchant_id, content_type, byte_size, data)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE content_type = VALUES(content_type),
       byte_size = VALUES(byte_size), data = VALUES(data), updated_at = CURRENT_TIMESTAMP`,
    [merchantId, contentType, buffer.length, buffer],
  )
}

export async function deleteSplashMedia(merchantId) {
  const [result] = await pool.query('DELETE FROM merchant_splash_media WHERE merchant_id = ?', [
    merchantId,
  ])
  return result.affectedRows > 0
}

/**
 * Send a merchant's media, honouring Range.
 *
 * Safari will not play a video at all from a server that ignores Range, so
 * this is required, not an optimisation. Cached like the image endpoints
 * because every URL built for it is versioned.
 */
export async function sendSplashMedia(req, res, merchantId, { scope = 'public' } = {}) {
  const meta = await readSplashMeta(merchantId)
  if (!meta) return res.status(404).json({ status: 'error', error: 'Media not found' })

  const size = Number(meta.byte_size)
  const range = parseRange(req.get('range'), size)
  res.set('Accept-Ranges', 'bytes')
  res.set('Cache-Control', `${scope}, max-age=31536000, immutable`)
  // Same sandboxed, script-free policy as sendImage: these URLs can be opened
  // directly, and the bytes were uploaded by a merchant.
  res.set('Content-Security-Policy', "default-src 'none'; media-src 'self'; img-src 'self'; sandbox")

  if (range === RANGE_UNSATISFIABLE) {
    res.set('Content-Range', `bytes */${size}`)
    return res.status(416).end()
  }

  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  const [rows] = await pool.query(
    'SELECT SUBSTRING(data, ?, ?) AS chunk FROM merchant_splash_media WHERE merchant_id = ?',
    [start + 1, end - start + 1, merchantId],
  )
  const chunk = rows[0]?.chunk
  if (!Buffer.isBuffer(chunk)) {
    return res.status(404).json({ status: 'error', error: 'Media not found' })
  }

  res.set('Content-Type', meta.content_type)
  res.set('Content-Length', String(chunk.length))
  if (range) {
    res.status(206)
    res.set('Content-Range', `bytes ${start}-${start + chunk.length - 1}/${size}`)
  }
  // end(), not send(): send() would compute an ETag over one slice and could
  // answer a later range with a 304 meant for a different part of the file.
  return res.end(chunk)
}
