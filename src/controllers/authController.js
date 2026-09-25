import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pool from '../config/db.js'
import { JWT_SECRET, JWT_EXPIRES_IN, MIN_PASSWORD_LENGTH } from '../config/auth.js'
import { sendPasswordResetEmail } from '../utils/mailer.js'
import {
  MERCHANT_COOKIE,
  ADMIN_COOKIE,
  setAuthCookie,
  clearAuthCookie,
} from '../utils/cookies.js'
import { appUrl } from '../config/appUrl.js'
import { ERROR_CODES, errorBody } from '../utils/errorCodes.js'
import { suspendExpiredSubscriptions } from '../services/subscriptions.js'

const isProd = process.env.NODE_ENV === 'production'

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

/** Return the merchant_id for a valid (unexpired) reset token, or null. */
async function findValidReset(token) {
  if (!token || typeof token !== 'string') return null
  const [rows] = await pool.query(
    `SELECT merchant_id FROM password_resets
     WHERE token_hash = ? AND expires_at > NOW()`,
    [sha256(token)],
  )
  return rows[0]?.merchant_id ?? null
}

// POST /api/auth/login  { email, password }
// The one sign-in for both roles: the credentials themselves decide which.
// Responds { role: 'admin', admin } or { role: 'merchant', merchant } so the
// frontend knows which panel to open.
export async function login(req, res, next) {
  try {
    const { email, password } = req.body ?? {}
    if (!email || !password) {
      return res
        .status(400)
        .json({ status: 'error', error: 'Email and password are required' })
    }
    const address = email.trim()

    // Admins are matched first, so an address present in both tables signs in
    // as the higher-privilege account.
    const [adminRows] = await pool.query(
      'SELECT id, name, email, password_hash FROM admins WHERE email = ?',
      [address],
    )
    const admin = adminRows[0]
    if (
      admin?.password_hash &&
      (await bcrypt.compare(password, admin.password_hash))
    ) {
      const token = jwt.sign(
        { adminId: admin.id, email: admin.email, role: 'admin' },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN },
      )
      setAuthCookie(res, ADMIN_COOKIE, token)
      // One sign-in grants one role: drop any session left from the other.
      clearAuthCookie(res, MERCHANT_COOKIE)

      return res.json({
        role: 'admin',
        admin: { id: admin.id, email: admin.email, name: admin.name },
      })
    }

    const [merchantRows] = await pool.query(
      'SELECT id, email, business_name, password_hash, status FROM merchants WHERE email = ?',
      [address],
    )
    const merchant = merchantRows[0]

    // Same generic response whether the email is unknown to both tables or the
    // password is wrong (don't leak which emails exist).
    const ok =
      merchant?.password_hash &&
      (await bcrypt.compare(password, merchant.password_hash))
    if (!ok) {
      return res
        .status(401)
        .json(errorBody('Invalid email or password', ERROR_CODES.INVALID_CREDENTIALS))
    }

    // Suspension is checked AFTER the password so we only reveal it to the
    // real account owner, not to an attacker probing emails.
    const expiredNow = await suspendExpiredSubscriptions({ merchantId: merchant.id })
    if (merchant.status === 'suspended' || expiredNow > 0) {
      return res.status(403).json(
        errorBody(
          'Account suspended. Please contact the platform administrator.',
          ERROR_CODES.ACCOUNT_SUSPENDED,
        ),
      )
    }

    const token = jwt.sign(
      { merchantId: merchant.id, email: merchant.email, role: 'merchant' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN },
    )

    // Token goes into an httpOnly cookie (not the body / not JS-readable).
    setAuthCookie(res, MERCHANT_COOKIE, token)
    clearAuthCookie(res, ADMIN_COOKIE)

    res.json({
      role: 'merchant',
      merchant: {
        id: merchant.id,
        email: merchant.email,
        businessName: merchant.business_name,
      },
    })
  } catch (err) {
    next(err)
  }
}

// POST /api/auth/logout
export function logout(req, res) {
  clearAuthCookie(res, MERCHANT_COOKIE)
  res.json({ ok: true })
}

// POST /api/auth/forgot-password  { email }
// Always responds the same way so it can't be used to discover which emails
// have accounts. If the email matches a merchant, a single-use, 1-hour reset
// token is issued (superseding any previous one).
export async function forgotPassword(req, res, next) {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
    const generic = {
      message:
        'If an account exists for that email, a password reset link has been sent.',
    }
    if (!email) return res.json(generic)

    const [rows] = await pool.query(
      'SELECT id, email FROM merchants WHERE email = ?',
      [email],
    )
    const merchant = rows[0]

    let devResetUrl
    if (merchant) {
      // One outstanding token per merchant.
      await pool.query('DELETE FROM password_resets WHERE merchant_id = ?', [
        merchant.id,
      ])
      const token = crypto.randomBytes(32).toString('base64url')
      await pool.query(
        `INSERT INTO password_resets (merchant_id, token_hash, expires_at)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
        [merchant.id, sha256(token)],
      )
      const resetUrl = `${appUrl()}/merchant/reset-password?token=${token}`
      await sendPasswordResetEmail(merchant.email, resetUrl)
      // In dev only, hand the link back so it can be tested without email.
      if (!isProd) devResetUrl = resetUrl
    }

    res.json(devResetUrl ? { ...generic, devResetUrl } : generic)
  } catch (err) {
    next(err)
  }
}

// GET /api/auth/reset-password/validate?token=...
// Lets the reset page tell a valid link from an expired/bad one before showing
// the form. Reveals only a boolean.
export async function validateResetToken(req, res, next) {
  try {
    const merchantId = await findValidReset(req.query?.token)
    res.json({ valid: Boolean(merchantId) })
  } catch (err) {
    next(err)
  }
}

// POST /api/auth/reset-password  { token, password }
export async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.body ?? {}
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        status: 'error',
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      })
    }
    const merchantId = await findValidReset(token)
    if (!merchantId) {
      return res.status(400).json({
        status: 'error',
        error: 'This reset link is invalid or has expired.',
      })
    }

    const passwordHash = await bcrypt.hash(password, 10)
    await pool.query('UPDATE merchants SET password_hash = ? WHERE id = ?', [
      passwordHash,
      merchantId,
    ])
    // Consume the token (single use) + clear any siblings.
    await pool.query('DELETE FROM password_resets WHERE merchant_id = ?', [
      merchantId,
    ])

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
}
