import pool from '../config/db.js'
import { BANNER_LIST_COLUMNS, bannersAvailable } from '../db/banners.js'
import { ERROR_CODES, errorBody } from '../utils/errorCodes.js'
import { imageVersion, sendImage } from '../utils/imageResponse.js'
import {
  MAX_BANNERS,
  groupLinkTargets,
  linkTargetSets,
  mapBanner,
  normalizeBannerInput,
} from '../utils/banners.js'

/**
 * The merchant's own storefront banners.
 *
 * Every handler scopes to req.merchantId (set by requireAuth from the token,
 * never the body), so a merchant can only see or change their own.
 *
 * Images arrive as data URLs — downscaled in the browser by the same pipeline
 * as product photos — but go back out as URLs. Unlike the menu editor, this
 * page never has to resend an image it isn't replacing, so it never needs the
 * bytes in JSON.
 *
 * Oversized uploads need nothing here: express.json's limit and MySQL's
 * max_allowed_packet both reach the central error handler, which already
 * explains them (IMAGE_TOO_LARGE, and dbErrors.js's ER_NET_PACKET_TOO_LARGE).
 */

const myBannerImageUrl = (bannerId, updatedAt) =>
  `/api/merchant/banners/${bannerId}/image?v=${imageVersion(updatedAt)}`

const unavailable = (res) =>
  res
    .status(503)
    .json(
      errorBody(
        'Storefront banners need a database update: run "npm run db:add-banners" in backend/ and restart the API.',
        ERROR_CODES.BANNERS_UNAVAILABLE,
      ),
    )

const notFound = (res) =>
  res.status(404).json(errorBody('Banner not found', ERROR_CODES.BANNER_NOT_FOUND))

const INPUT_MESSAGES = {
  BANNER_IMAGE_REQUIRED: 'Choose an image for the banner.',
  BANNER_LINK_INVALID: 'That link points to a product or category that is not in your menu.',
}

const rejectInput = (res, code) =>
  res.status(400).json(errorBody(INPUT_MESSAGES[code], ERROR_CODES[code]))

async function readBanner(merchantId, bannerId) {
  const [rows] = await pool.query(
    `SELECT ${BANNER_LIST_COLUMNS} FROM merchant_banners WHERE id = ? AND merchant_id = ?`,
    [bannerId, merchantId],
  )
  return rows[0] ?? null
}

/** A link may only point at this merchant's own product or category. */
async function ownsLinkTarget(merchantId, linkType, linkId) {
  if (linkType === 'none') return true
  const table = linkType === 'product' ? 'products' : 'categories'
  const [rows] = await pool.query(`SELECT id FROM ${table} WHERE id = ? AND merchant_id = ?`, [
    linkId,
    merchantId,
  ])
  return rows.length > 0
}

// GET /api/merchant/banners
/**
 * The banners, plus what the editor needs around them: whether this database
 * can store banners at all, the limit, and the menu to pick links from (names
 * only — the full menu carries every product photo as base64).
 */
export async function listMyBanners(req, res, next) {
  try {
    const [categories] = await pool.query(
      'SELECT id, name FROM categories WHERE merchant_id = ? ORDER BY position, id',
      [req.merchantId],
    )
    const [products] = await pool.query(
      'SELECT id, category_id, name FROM products WHERE merchant_id = ? ORDER BY position, id',
      [req.merchantId],
    )

    const available = await bannersAvailable()
    let banners = []
    if (available) {
      const [rows] = await pool.query(
        `SELECT ${BANNER_LIST_COLUMNS} FROM merchant_banners
         WHERE merchant_id = ? ORDER BY position, id`,
        [req.merchantId],
      )
      const linkTargets = linkTargetSets(categories, products)
      banners = rows.map((row) => mapBanner(row, { imageUrl: myBannerImageUrl, linkTargets }))
    }

    res.json({
      available,
      max: MAX_BANNERS,
      banners,
      linkTargets: groupLinkTargets(categories, products),
    })
  } catch (err) {
    next(err)
  }
}

// POST /api/merchant/banners  { image, title?, linkType?, linkId?, isActive? }
export async function createBanner(req, res, next) {
  try {
    if (!(await bannersAvailable())) return unavailable(res)

    const { fields, error } = normalizeBannerInput(req.body)
    if (error) return rejectInput(res, error)

    const [[{ n }]] = await pool.query(
      'SELECT COUNT(*) AS n FROM merchant_banners WHERE merchant_id = ?',
      [req.merchantId],
    )
    if (Number(n) >= MAX_BANNERS) {
      return res
        .status(409)
        .json(
          errorBody(
            `A storefront can have at most ${MAX_BANNERS} banners. Delete one to add another.`,
            ERROR_CODES.BANNER_LIMIT_REACHED,
            { max: MAX_BANNERS },
          ),
        )
    }
    if (!(await ownsLinkTarget(req.merchantId, fields.linkType, fields.linkId))) {
      return rejectInput(res, 'BANNER_LINK_INVALID')
    }

    // New banners go to the end, where the merchant is looking when they add one.
    const [[{ nextPos }]] = await pool.query(
      'SELECT COALESCE(MAX(position) + 1, 0) AS nextPos FROM merchant_banners WHERE merchant_id = ?',
      [req.merchantId],
    )
    const [result] = await pool.query(
      `INSERT INTO merchant_banners
         (merchant_id, image, title, link_type, link_id, position, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.merchantId,
        fields.image,
        fields.title,
        fields.linkType,
        fields.linkId,
        nextPos,
        fields.isActive ? 1 : 0,
      ],
    )
    const row = await readBanner(req.merchantId, result.insertId)
    res.status(201).json(mapBanner(row, { imageUrl: myBannerImageUrl }))
  } catch (err) {
    next(err)
  }
}

const COLUMN_FOR = {
  image: 'image',
  title: 'title',
  linkType: 'link_type',
  linkId: 'link_id',
  isActive: 'is_active',
}

// PATCH /api/merchant/banners/:id  { image?, title?, linkType?, linkId?, isActive? }
export async function updateBanner(req, res, next) {
  try {
    if (!(await bannersAvailable())) return unavailable(res)

    const { fields, error } = normalizeBannerInput(req.body, { partial: true })
    if (error) return rejectInput(res, error)
    if (!Object.keys(fields).length) {
      return res.status(400).json({ status: 'error', error: 'No banner fields provided' })
    }
    if (!(await readBanner(req.merchantId, req.params.id))) return notFound(res)
    if ('linkType' in fields && !(await ownsLinkTarget(req.merchantId, fields.linkType, fields.linkId))) {
      return rejectInput(res, 'BANNER_LINK_INVALID')
    }

    const sets = []
    const values = []
    for (const [field, column] of Object.entries(COLUMN_FOR)) {
      if (!(field in fields)) continue
      sets.push(`${column} = ?`)
      values.push(field === 'isActive' ? (fields.isActive ? 1 : 0) : fields[field])
    }
    // updated_at versions the image URL, so only a new image may move it.
    // Assigning it to itself stops ON UPDATE CURRENT_TIMESTAMP; otherwise
    // renaming a slide or switching it off would make every customer
    // re-download a picture that hasn't changed.
    if (!('image' in fields)) sets.push('updated_at = updated_at')
    values.push(req.params.id, req.merchantId)
    await pool.query(
      `UPDATE merchant_banners SET ${sets.join(', ')} WHERE id = ? AND merchant_id = ?`,
      values,
    )

    const row = await readBanner(req.merchantId, req.params.id)
    res.json(mapBanner(row, { imageUrl: myBannerImageUrl }))
  } catch (err) {
    next(err)
  }
}

// PATCH /api/merchant/banners/order  { ids: [3, 1, 2] }
export async function reorderBanners(req, res, next) {
  try {
    if (!(await bannersAvailable())) return unavailable(res)

    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : []
    const [rows] = await pool.query('SELECT id FROM merchant_banners WHERE merchant_id = ?', [
      req.merchantId,
    ])
    const mine = new Set(rows.map((row) => Number(row.id)))

    // The complete list, each id once, every one this merchant's. Anything
    // else means the page is stale (a banner deleted in another tab), and
    // applying part of an order would leave two banners sharing a position.
    const complete =
      ids.length === mine.size && new Set(ids).size === ids.length && ids.every((id) => mine.has(id))
    if (!complete) {
      return res
        .status(409)
        .json(
          errorBody(
            'Your banners changed since this page loaded. Reload and try again.',
            ERROR_CODES.BANNER_NOT_FOUND,
          ),
        )
    }

    if (ids.length) {
      // One statement, so a reorder can never be half-applied. updated_at is
      // pinned for the same reason as in updateBanner.
      //
      // Limited to the ids just checked. A banner created in another tab
      // between that check and this write has no WHEN branch, so across the
      // merchant's whole set it would get position NULL — a 500 on strict
      // MySQL, or silently 0 elsewhere. Left out, it keeps its own position.
      await pool.query(
        `UPDATE merchant_banners
         SET position = CASE id ${ids.map(() => 'WHEN ? THEN ?').join(' ')} END,
             updated_at = updated_at
         WHERE merchant_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
        [...ids.flatMap((id, index) => [id, index]), req.merchantId, ...ids],
      )
    }
    res.json({ ids })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/merchant/banners/:id
export async function deleteBanner(req, res, next) {
  try {
    if (!(await bannersAvailable())) return unavailable(res)
    const [result] = await pool.query(
      'DELETE FROM merchant_banners WHERE id = ? AND merchant_id = ?',
      [req.params.id, req.merchantId],
    )
    if (!result.affectedRows) return notFound(res)
    res.json({ id: Number(req.params.id), deleted: true })
  } catch (err) {
    next(err)
  }
}

// GET /api/merchant/banners/:id/image
/**
 * The editor's own view of a banner, including inactive ones — the storefront
 * endpoint only serves what customers can see.
 */
export async function getMyBannerImage(req, res, next) {
  try {
    if (!(await bannersAvailable())) return notFound(res)
    const [rows] = await pool.query(
      'SELECT image FROM merchant_banners WHERE id = ? AND merchant_id = ?',
      [req.params.id, req.merchantId],
    )
    if (!rows.length) return notFound(res)
    return sendImage(res, rows[0].image, { scope: 'private' })
  } catch (err) {
    next(err)
  }
}
