import jwt from 'jsonwebtoken'
import pool from '../config/db.js'
import { JWT_SECRET } from '../config/auth.js'
import { MERCHANT_COOKIE, ADMIN_COOKIE } from '../utils/cookies.js'
import { ERROR_CODES, errorBody } from '../utils/errorCodes.js'
import { suspendExpiredSubscriptions } from '../services/subscriptions.js'
import { adminRole } from '../utils/adminRoles.js'

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
    const expiredNow = await suspendExpiredSubscriptions({ merchantId: payload.merchantId })
    if (expiredNow > 0) {
      return res
        .status(403)
        .json(errorBody('Account suspended', ERROR_CODES.ACCOUNT_SUSPENDED))
    }
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
export async function requireAdmin(req, res, next) {
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
  // The role comes from the database on every request, never the token: a
  // sub-admin the main admin deletes loses access at once, rather than when
  // their 7-day token expires. SELECT * so an install without the role
  // column reads every admin as 'super' (see adminRole).
  try {
    const [rows] = await pool.query('SELECT * FROM admins WHERE id = ?', [payload.adminId])
    if (!rows.length) {
      return res.status(401).json({ status: 'error', error: 'Account no longer exists' })
    }
    if (adminRole(rows[0]) === 'sub' && rows[0].status === 'blocked') {
      return res.status(401).json({ status: 'error', error: 'Account disabled' })
    }
    req.admin = {
      id: rows[0].id,
      email: rows[0].email,
      name: rows[0].name ?? '',
      role: adminRole(rows[0]),
    }
  } catch (err) {
    return next(err)
  }
  next()
}

/**
 * Reads open to every admin, writes for the main admin only — for data a
 * sub-admin's forms need to show but must not change (the plans list).
 */
export function requireSuperAdminForWrites(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next()
  return requireSuperAdmin(req, res, next)
}

/**
 * Only the main admin. Mounted after requireAdmin on every platform-wide area
 * (overview, revenue, plans, orders, reviews, notifications, sub-admins): a
 * sub-admin works in Merchants alone.
 */
export function requireSuperAdmin(req, res, next) {
  if (req.admin?.role === 'super') return next()
  return res
    .status(403)
    .json(errorBody('Only the main admin can do this.', ERROR_CODES.ADMIN_FORBIDDEN))
}
