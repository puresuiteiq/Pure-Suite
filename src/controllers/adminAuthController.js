import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pool from '../config/db.js'
import { JWT_SECRET, JWT_EXPIRES_IN } from '../config/auth.js'
import { ERROR_CODES, errorBody } from '../utils/errorCodes.js'
import {
  ADMIN_COOKIE,
  setAuthCookie,
  clearAuthCookie,
} from '../utils/cookies.js'

// POST /api/admin/login  { email, password }
export async function adminLogin(req, res, next) {
  try {
    const { email, password } = req.body ?? {}
    if (!email || !password) {
      return res
        .status(400)
        .json({ status: 'error', error: 'Email and password are required' })
    }

    const [rows] = await pool.query(
      'SELECT id, name, email, password_hash FROM admins WHERE email = ?',
      [email.trim()],
    )
    const admin = rows[0]

    const ok =
      admin?.password_hash && (await bcrypt.compare(password, admin.password_hash))
    if (!ok) {
      return res
        .status(401)
        .json(errorBody('Invalid email or password', ERROR_CODES.INVALID_CREDENTIALS))
    }

    const token = jwt.sign(
      { adminId: admin.id, email: admin.email, role: 'admin' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN },
    )

    setAuthCookie(res, ADMIN_COOKIE, token)

    res.json({
      admin: { id: admin.id, email: admin.email, name: admin.name },
    })
  } catch (err) {
    next(err)
  }
}

// POST /api/admin/logout
export function adminLogout(req, res) {
  clearAuthCookie(res, ADMIN_COOKIE)
  res.json({ ok: true })
}
