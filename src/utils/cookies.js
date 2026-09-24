/**
 * httpOnly auth cookies. Two names so a browser can hold a merchant and an
 * admin session at once; each middleware reads its own.
 *
 * `secure` is enabled only in production — on http://localhost a Secure cookie
 * would never be set/sent, breaking local dev. `sameSite: 'lax'` gives basic
 * CSRF protection while still allowing normal top-level navigation.
 */
const isProd = process.env.NODE_ENV === 'production'

export const MERCHANT_COOKIE = 'merchant_token'
export const ADMIN_COOKIE = 'admin_token'

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days, matches JWT expiry

const baseOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  path: '/',
}

export function setAuthCookie(res, name, token) {
  res.cookie(name, token, { ...baseOptions, maxAge: MAX_AGE_MS })
}

export function clearAuthCookie(res, name) {
  // Options (except maxAge/expires) must match those used when setting.
  res.clearCookie(name, baseOptions)
}
