import crypto from 'node:crypto'

/**
 * CSRF protection via the double-submit cookie pattern.
 *
 * A random token is stored in a NON-httpOnly cookie (so the frontend JS can
 * read it) and must be echoed back in the `X-CSRF-Token` header on every
 * state-changing request. The server checks header === cookie. A cross-site
 * attacker can cause the browser to SEND the cookie but cannot READ it (same
 * origin policy) to set the matching header, nor set custom headers on a
 * cross-site form post — so a match proves the request is same-origin.
 */
export const CSRF_COOKIE = 'csrf_token'

const isProd = process.env.NODE_ENV === 'production'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const cookieOptions = {
  httpOnly: false, // must be readable by JS for the double-submit header
  secure: isProd, // Secure only in prod (would break http://localhost dev)
  sameSite: 'lax',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/**
 * GET /api/csrf-token — ensures a CSRF cookie exists (reusing an existing one)
 * and returns the token so the client can send it as a header.
 */
export function issueCsrfToken(req, res) {
  let token = req.cookies?.[CSRF_COOKIE]
  if (!token) {
    token = crypto.randomBytes(32).toString('hex')
    res.cookie(CSRF_COOKIE, token, cookieOptions)
  }
  res.json({ csrfToken: token })
}

/** Guard state-changing methods; safe (read-only) methods pass through. */
export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next()

  const cookieToken = req.cookies?.[CSRF_COOKIE]
  const headerToken = req.get('X-CSRF-Token')

  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    return res.status(403).json({ status: 'error', error: 'Invalid CSRF token' })
  }
  next()
}
