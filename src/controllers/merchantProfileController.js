import bcrypt from 'bcryptjs'
import pool from '../config/db.js'
import { MIN_PASSWORD_LENGTH } from '../config/auth.js'
import { mapProfile, normalizeStorefrontTheme } from '../utils/mappers.js'
import { ERROR_CODES, errorBody } from '../utils/errorCodes.js'
import { normalizeSplashTagline } from '../utils/splash.js'
import { mySplashMediaUrl, splashFields } from '../db/splash.js'

// Read every column and let mapProfile pick + default what it needs. Naming
// columns explicitly meant a new column (e.g. reviews_enabled) crashed this
// query until its migration ran; `*` is resilient, and mapProfile only ever
// outputs whitelisted fields (never password_hash), so nothing sensitive leaks.
const PROFILE_COLUMNS = '*'

/** The profile plus its welcome-screen fields (whose media lives in its own table). */
async function profileResponse(merchantId, row) {
  return { ...mapProfile(merchantId, row), ...(await splashFields(merchantId, row, mySplashMediaUrl)) }
}

// GET /api/merchant/profile   (merchantId from token)
export async function getMyProfile(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT ${PROFILE_COLUMNS} FROM merchants WHERE id = ?`,
      [req.merchantId],
    )
    if (!rows.length) {
      return res.status(404).json({ status: 'error', error: 'Merchant not found' })
    }
    res.json(await profileResponse(req.merchantId, rows[0]))
  } catch (err) {
    next(err)
  }
}

// Editable profile fields → their DB columns.
const FIELD_TO_COLUMN = {
  businessName: 'business_name',
  logo: 'logo',
  phone: 'phone',
  address: 'address',
  mapUrl: 'map_url',
  description: 'description',
  isOpen: 'is_open',
  reviewsEnabled: 'reviews_enabled',
  showBanner: 'show_banner',
  dailyOrderNumbers: 'daily_order_numbers',
  accentColor: 'accent_color',
  accentShadow: 'accent_shadow',
  panelColor: 'panel_color',
  panelShadow: 'panel_shadow',
  storefrontBackground: 'storefront_background',
  storefrontBackgroundShadow: 'storefront_background_shadow',
  storefrontBackgroundDark: 'storefront_background_dark',
  storefrontBackgroundShadowDark: 'storefront_background_shadow_dark',
  priceColor: 'price_color',
  latitude: 'latitude',
  longitude: 'longitude',
  serviceMethods: 'service_methods',
  socialLinks: 'social_links',
  workingHours: 'working_hours',
  splashEnabled: 'splash_enabled',
  splashTagline: 'splash_tagline',
  storefrontTheme: 'storefront_theme',
}

const HEX_COLOR_FIELDS = new Set([
  'accentColor',
  'accentShadow',
  'panelColor',
  'panelShadow',
  'storefrontBackground',
  'storefrontBackgroundShadow',
  'storefrontBackgroundDark',
  'storefrontBackgroundShadowDark',
  'priceColor',
])

// Accept a #rgb / #rrggbb / #rrggbbaa hex colour, normalised to lowercase;
// anything else (including empty) becomes null ("no colour set"). Guards the DB
// against arbitrary strings so the storefront only ever inlines a real colour.
function normalizeHexColor(value) {
  if (!value) return null
  const hex = String(value).trim().toLowerCase()
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex) ? hex : null
}

// Map-picker coordinates: a finite number within the real range for that
// axis, or null ("not set"). Guards the DB the same way normalizeHexColor
// does for colours — the storefront only ever gets a coordinate it can
// actually hand to Google Maps.
function normalizeCoordinate(value, max) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null
}

function normalizeMapUrl(value) {
  if (!value) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    return ['http:', 'https:'].includes(url.protocol) ? trimmed.slice(0, 1024) : null
  } catch {
    return null
  }
}

// PATCH /api/merchant/profile   (merchantId from token)
export async function updateMyProfile(req, res, next) {
  try {
    const body = req.body ?? {}

    // Which columns actually exist, so a field whose migration hasn't run yet
    // (e.g. reviews_enabled) is skipped rather than crashing the whole save.
    const [colRows] = await pool.query(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'merchants'`,
    )
    const existingColumns = new Set(colRows.map((c) => c.name))

    // Build the SET clause only from fields present in the request.
    const assignments = []
    const values = []
    for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue
      if (!existingColumns.has(column)) continue // column not migrated yet
      let value = body[field]

      if (field === 'businessName') {
        if (!value || !String(value).trim()) {
          return res
            .status(400)
            .json({ status: 'error', error: 'Business name is required' })
        }
        value = String(value).trim()
      } else if (field === 'phone' || field === 'address' || field === 'description') {
        value = value ? String(value).trim() : null
      } else if (field === 'mapUrl') {
        value = normalizeMapUrl(value)
      } else if (field === 'logo') {
        value = value || null
      } else if (
        field === 'isOpen' ||
        field === 'reviewsEnabled' ||
        field === 'showBanner' ||
        field === 'dailyOrderNumbers' ||
        field === 'splashEnabled'
      ) {
        value = value ? 1 : 0
      } else if (field === 'storefrontTheme') {
        value = normalizeStorefrontTheme(value)
      } else if (field === 'splashTagline') {
        value = normalizeSplashTagline(value)
      } else if (HEX_COLOR_FIELDS.has(field)) {
        value = normalizeHexColor(value)
      } else if (field === 'latitude') {
        value = normalizeCoordinate(value, 90)
      } else if (field === 'longitude') {
        value = normalizeCoordinate(value, 180)
      } else if (field === 'workingHours' || field === 'serviceMethods' || field === 'socialLinks') {
        // JSON column: mysql2 won't stringify objects for us.
        value = value == null ? null : JSON.stringify(value)
      }

      assignments.push(`${column} = ?`)
      values.push(value)
    }

    if (!assignments.length) {
      return res
        .status(400)
        .json({ status: 'error', error: 'No profile fields provided' })
    }

    const [existing] = await pool.query('SELECT id FROM merchants WHERE id = ?', [
      req.merchantId,
    ])
    if (!existing.length) {
      return res.status(404).json({ status: 'error', error: 'Merchant not found' })
    }

    values.push(req.merchantId)
    await pool.query(
      `UPDATE merchants SET ${assignments.join(', ')} WHERE id = ?`,
      values,
    )

    const [rows] = await pool.query(
      `SELECT ${PROFILE_COLUMNS} FROM merchants WHERE id = ?`,
      [req.merchantId],
    )
    res.json(await profileResponse(req.merchantId, rows[0]))
  } catch (err) {
    next(err)
  }
}

/**
 * POST /api/merchant/change-password  { currentPassword, newPassword }
 *
 * A merchant's only route to a new password was to ask the Super Admin to mint
 * a temporary one, or to use a "forgot password" flow that was unreachable in
 * the UI and sent no mail. Both mean a third party handles their credential.
 *
 * merchantId comes from the token (requireAuth), never the body, so this can
 * only ever change the caller's own password.
 */
export async function changeMyPassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body ?? {}

    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json(
        errorBody(
          `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
          ERROR_CODES.WEAK_PASSWORD,
          { min: MIN_PASSWORD_LENGTH },
        ),
      )
    }

    const [rows] = await pool.query('SELECT password_hash FROM merchants WHERE id = ?', [
      req.merchantId,
    ])
    if (!rows.length) {
      return res.status(404).json({ status: 'error', error: 'Merchant not found' })
    }

    const ok =
      typeof currentPassword === 'string' &&
      rows[0].password_hash &&
      (await bcrypt.compare(currentPassword, rows[0].password_hash))
    if (!ok) {
      return res
        .status(403)
        .json(errorBody('Your current password is not correct.', ERROR_CODES.CURRENT_PASSWORD_WRONG))
    }

    await pool.query('UPDATE merchants SET password_hash = ? WHERE id = ?', [
      await bcrypt.hash(newPassword, 10),
      req.merchantId,
    ])

    // Deliberately changing the password must also void any outstanding reset
    // link. Otherwise a token issued before this — possibly by someone who
    // triggered the reset without permission — still works afterwards.
    await pool.query('DELETE FROM password_resets WHERE merchant_id = ?', [req.merchantId])

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
}
