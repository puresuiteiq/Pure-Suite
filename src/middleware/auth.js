import jwt from 'jsonwebtoken'
import pool from '../config/db.js'
import { JWT_SECRET } from '../config/auth.js'
import { MERCHANT_COOKIE, ADMIN_COOKIE } from '../utils/cookies.js'
import { ERROR_CODES, errorBody } from '../utils/errorCodes.js'

/**
 * Read the token from the role's httpOnly cookie (primary), falling back to an
 * `Authorization: Bearer` header (useful for API clients / tests).
 */
function getToken(req, cookieName) {
  const fromCookie = req.cookies?.[cookieName]
  if (fromCookie) return fromCookie
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

function verify(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch {
    return null
  }
}

/**
 * Require a valid MERCHANT token. Sets req.merchantId from the token (never
 * from client params/body), so a merchant can only reach their own data. An
 * admin token (no merchantId) is rejected.
 */
export async function requireAuth(req, res, next) {
  const token = getToken(req, MERCHANT_COOKIE)
  if (!token) {
    return res.status(401).json({ status: 'error', error: 'Authentication required' })
  }
  const payload = verify(token)
  if (!payload) {
    return res.status(401).json({ status: 'error', error: 'Invalid or expired token' })
  }
  if (!payload.merchantId) {
    return res.status(403).json({ status: 'error', error: 'Merchant access required' })
  }

  // Enforce suspension on every request, so a merchant suspended mid-session is
  // blocked immediately (not only at their next login).
  try {
    const [rows] = await pool.query(
      'SELECT status FROM merchants WHERE id = ?',
      [payload.merchantId],
    )
    if (!rows.length) {
      return res.status(401).json({ status: 'error', error: 'Account no longer exists' })
    }
    if (rows[0].status === 'suspended') {
      return res
        .status(403)
        .json(errorBody('Account suspended', ERROR_CODES.ACCOUNT_SUSPENDED))
    }
  } catch (err) {
    return next(err)
  }

  req.merchantId = payload.merchantId
  req.merchant = payload
  next()
}

/**
 * Require a valid ADMIN token (role='admin'). 401 for a missing/invalid token,
 * 403 for a valid token that isn't an admin (e.g. a merchant's).
 */
export function requireAdmin(req, res, next) {
  const token = getToken(req, ADMIN_COOKIE)
  if (!token) {
    return res.status(401).json({ status: 'error', error: 'Authentication required' })
  }
  const payload = verify(token)
  if (!payload) {
    return res.status(401).json({ status: 'error', error: 'Invalid or expired token' })
  }
  if (payload.role !== 'admin') {
    return res.status(403).json({ status: 'error', error: 'Admin access required' })
  }
  req.admin = { id: payload.adminId, email: payload.email }
  next()
}
