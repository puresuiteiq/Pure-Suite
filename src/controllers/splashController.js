import express from 'express'
import pool from '../config/db.js'
import { ERROR_CODES, errorBody } from '../utils/errorCodes.js'
import { SPLASH_MAX_BYTES, checkSplashUpload } from '../utils/splash.js'
import {
  deleteSplashMedia,
  mySplashMediaUrl,
  sendSplashMedia,
  splashAvailable,
  splashFields,
  storeSplashMedia,
} from '../db/splash.js'

/**
 * The merchant's own welcome-screen background.
 *
 * Unlike every other upload in the panel this is a raw body, not a data URL in
 * JSON: a video is up to 15 MB, which base64 would push past the API's JSON
 * limit. The enabled switch and tagline are ordinary profile fields and save
 * with the rest of the profile; only the media has its own endpoints.
 *
 * Every handler scopes to req.merchantId (from the token, never the body).
 */

const MAX_MB = Math.round(SPLASH_MAX_BYTES.video / (1024 * 1024))

const tooLarge = (res, max = MAX_MB) =>
  res
    .status(413)
    .json(
      errorBody(`That file is too large — the limit is ${max} MB.`, ERROR_CODES.SPLASH_MEDIA_TOO_LARGE, {
        max,
      }),
    )

const unavailable = (res) =>
  res
    .status(503)
    .json(
      errorBody(
        'The welcome screen needs a database update: run "npm run db:add-splash" in backend/ and restart the API.',
        ERROR_CODES.SPLASH_UNAVAILABLE,
      ),
    )

const rawParser = express.raw({ type: () => true, limit: SPLASH_MAX_BYTES.video })

/**
 * Read the raw body, answering an oversized one here: the central handler would
 * otherwise call it an image over 10 MB, which is neither the limit nor the kind.
 */
export function readSplashBody(req, res, next) {
  rawParser(req, res, (err) => {
    if (err?.type === 'entity.too.large') return tooLarge(res)
    next(err)
  })
}

async function currentSplash(merchantId) {
  const [rows] = await pool.query('SELECT * FROM merchants WHERE id = ?', [merchantId])
  return splashFields(merchantId, rows[0], mySplashMediaUrl)
}

// PUT /api/merchant/splash/media   (raw body: the picture or video itself)
export async function uploadMySplashMedia(req, res, next) {
  try {
    if (!(await splashAvailable())) return unavailable(res)

    const { media, error, params } = checkSplashUpload(req.body)
    if (error === 'SPLASH_MEDIA_TOO_LARGE') return tooLarge(res, params.max)
    if (error) {
      return res
        .status(400)
        .json(
          errorBody('Choose a picture (JPG, PNG, WebP) or an MP4 / WebM video.', ERROR_CODES[error]),
        )
    }

    await storeSplashMedia(req.merchantId, req.body, media.contentType)
    res.json(await currentSplash(req.merchantId))
  } catch (err) {
    next(err)
  }
}

// DELETE /api/merchant/splash/media
export async function deleteMySplashMedia(req, res, next) {
  try {
    if (!(await splashAvailable())) return unavailable(res)
    await deleteSplashMedia(req.merchantId)
    res.json(await currentSplash(req.merchantId))
  } catch (err) {
    next(err)
  }
}

// GET /api/merchant/splash/media — the panel's own preview, even while the screen is off.
export async function getMySplashMedia(req, res, next) {
  try {
    if (!(await splashAvailable())) return res.status(404).json({ status: 'error', error: 'Media not found' })
    return await sendSplashMedia(req, res, req.merchantId, { scope: 'private' })
  } catch (err) {
    next(err)
  }
}
