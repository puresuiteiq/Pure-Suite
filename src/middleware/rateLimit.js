import rateLimit, { ipKeyGenerator } from 'express-rate-limit'

/**
 * Request rate limiting.
 *
 * Nothing was throttled before this, which mattered most on two paths:
 *
 *   - POST /api/auth/login is the single sign-in for both roles, and the
 *     Super Admin's address was a constant committed to the repo. An
 *     unthrottled login is an offline-speed password guess against a known
 *     account.
 *   - The public storefront endpoints accept reviews and orders with no
 *     account at all. Neither can be deleted by a merchant, and orders feed
 *     the MRR and order dashboards, so spam there is permanent.
 *
 * Limits are env-tunable because the right number depends on deployment shape
 * (one shop on one connection vs. a city of them behind carrier NAT).
 */

const num = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const MINUTE = 60 * 1000

function loginIdentifier(req) {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  return email || `anonymous:${ipKeyGenerator(req.ip)}`
}

/**
 * Rejections use the same `{ status: 'error', error }` envelope every
 * controller returns, so apiClient surfaces the message like any other
 * failure instead of showing a bare "Request failed: 429".
 */
function jsonHandler(message) {
  return (req, res) => {
    res.status(429).json({ status: 'error', error: message })
  }
}

/**
 * Sign-in, password-reset request, and password-reset submit.
 *
 * `skipSuccessfulRequests` means a merchant signing in and out repeatedly is
 * never locked out — only failures count toward the limit, which is the thing
 * actually worth limiting.
 */
export const authLimiter = rateLimit({
  windowMs: num(process.env.RATE_LIMIT_AUTH_WINDOW_MIN, 15) * MINUTE,
  limit: num(process.env.RATE_LIMIT_AUTH_MAX, 10),
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonHandler(
    'Too many sign-in attempts. Please wait a few minutes and try again.',
  ),
})

const loginIpLimiter = rateLimit({
  windowMs: num(process.env.RATE_LIMIT_LOGIN_WINDOW_MIN, 15) * MINUTE,
  limit: num(process.env.RATE_LIMIT_LOGIN_IP_MAX, 20),
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: jsonHandler(
    'Too many sign-in attempts from this connection. Please wait a few minutes and try again.',
  ),
})

const loginAccountLimiter = rateLimit({
  windowMs: num(process.env.RATE_LIMIT_LOGIN_WINDOW_MIN, 15) * MINUTE,
  limit: num(process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX, 5),
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: loginIdentifier,
  handler: jsonHandler(
    'Too many failed sign-in attempts for this account. Please wait a few minutes and try again.',
  ),
})

export const loginLimiter = [loginIpLimiter, loginAccountLimiter]

/**
 * Unauthenticated storefront writes (reviews, orders).
 *
 * Deliberately far looser than the auth limiter: a busy restaurant at lunch is
 * many genuine orders from one venue, and everyone on one shop's wifi shares an
 * IP. This is sized to stop scripted flooding, not to police real customers.
 */
export const publicWriteLimiter = rateLimit({
  windowMs: num(process.env.RATE_LIMIT_PUBLIC_WINDOW_MIN, 10) * MINUTE,
  limit: num(process.env.RATE_LIMIT_PUBLIC_MAX, 40),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Only guard the writes. Browsing a menu is a GET and must stay unlimited —
  // a storefront that stops loading is worse than the spam it would prevent.
  skip: (req) => req.method === 'GET' || req.method === 'HEAD',
  handler: jsonHandler('Too many requests. Please wait a moment and try again.'),
})

/**
 * How many reverse proxies sit in front of the app.
 *
 * This is load-bearing for the limiters: behind a proxy with no trust setting,
 * every request carries the proxy's IP, so the whole platform shares one
 * counter and the first ten bad passwords lock out everyone. Express's own
 * default (disabled) is right for local development and wrong for every hosted
 * deploy, so production defaults to a single hop — the shape of Railway,
 * Render, Fly, and a typical Nginx front end.
 *
 * Set TRUST_PROXY explicitly when the chain is longer or absent.
 */
export function trustProxyHops() {
  const explicit = process.env.TRUST_PROXY
  if (explicit !== undefined && explicit !== '') {
    const n = Number(explicit)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  return process.env.NODE_ENV === 'production' ? 1 : 0
}
