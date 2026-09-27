import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import pool from '../config/db.js'
import { ERROR_CODES, errorBody } from '../utils/errorCodes.js'

/**
 * Sub-admins, managed by the main admin (mounted behind requireSuperAdmin).
 *
 * A sub-admin adds merchants and manages only the ones they added — see
 * utils/adminRoles.js for the rules, merchantsController for where they bite.
 * Like a merchant, a new sub-admin gets a generated password, shown to the
 * main admin exactly once.
 */

const tempPassword = () => crypto.randomBytes(9).toString('base64url')

let roleColumn = null
async function hasRoleColumn() {
  if (roleColumn === null) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'admins' AND column_name = 'role'`,
    )
    roleColumn = Number(rows[0].n) > 0
  }
  return roleColumn
}

const unavailable = (res) =>
  res.status(503).json({
    status: 'error',
    error: 'Sub-admins need a database update: run "npm run db:add-admin-roles" in backend/ and restart the API.',
  })

const mapSubAdmin = (row) => ({
  id: Number(row.id),
  name: row.name ?? '',
  email: row.email,
  merchantCount: Number(row.merchant_count ?? 0),
  createdAt: row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : null,
})

async function readSubAdmin(id) {
  const [rows] = await pool.query(
    `SELECT a.id, a.name, a.email, a.created_at,
            (SELECT COUNT(*) FROM merchants m WHERE m.created_by_admin_id = a.id) AS merchant_count
       FROM admins a WHERE a.id = ? AND a.role = 'sub'`,
    [id],
  )
  return rows[0] ?? null
}

// GET /api/admins
export async function listSubAdmins(req, res, next) {
  try {
    if (!(await hasRoleColumn())) return res.json([])
    const [rows] = await pool.query(
      `SELECT a.id, a.name, a.email, a.created_at,
              (SELECT COUNT(*) FROM merchants m WHERE m.created_by_admin_id = a.id) AS merchant_count
         FROM admins a WHERE a.role = 'sub'
        ORDER BY a.created_at DESC, a.id DESC`,
    )
    res.json(rows.map(mapSubAdmin))
  } catch (err) {
    next(err)
  }
}

// POST /api/admins  { name, email }
export async function createSubAdmin(req, res, next) {
  try {
    if (!(await hasRoleColumn())) return unavailable(res)
    const name = String(req.body?.name ?? '').trim().slice(0, 150)
    const email = String(req.body?.email ?? '').trim().slice(0, 190)
    if (!name) return res.status(400).json({ status: 'error', error: 'Name is required' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ status: 'error', error: 'A valid email is required' })
    }

    // The email is a login, and sign-in tries admins before merchants: a
    // sub-admin sharing a merchant's email would lock that merchant out.
    const [[{ taken }]] = await pool.query(
      `SELECT (SELECT COUNT(*) FROM admins WHERE email = ?) +
              (SELECT COUNT(*) FROM merchants WHERE email = ?) AS taken`,
      [email, email],
    )
    if (Number(taken) > 0) {
      return res
        .status(409)
        .json(errorBody('That email is already used by another account.', ERROR_CODES.EMAIL_TAKEN))
    }

    const password = tempPassword()
    const [result] = await pool.query(
      `INSERT INTO admins (name, email, password_hash, role, created_by) VALUES (?, ?, ?, 'sub', ?)`,
      [name, email, await bcrypt.hash(password, 10), req.admin.id],
    )
    res.status(201).json({ ...mapSubAdmin(await readSubAdmin(result.insertId)), tempPassword: password })
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res
        .status(409)
        .json(errorBody('That email is already used by another account.', ERROR_CODES.EMAIL_TAKEN))
    }
    next(err)
  }
}

// POST /api/admins/:id/reset-password
export async function resetSubAdminPassword(req, res, next) {
  try {
    if (!(await hasRoleColumn())) return unavailable(res)
    if (!(await readSubAdmin(req.params.id))) {
      return res.status(404).json({ status: 'error', error: 'Sub-admin not found' })
    }
    const password = tempPassword()
    await pool.query(`UPDATE admins SET password_hash = ? WHERE id = ? AND role = 'sub'`, [
      await bcrypt.hash(password, 10),
      req.params.id,
    ])
    res.json({ tempPassword: password })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/admins/:id
/**
 * Removes the sub-admin; their merchants stay exactly as they are, still
 * marked as theirs, so the main admin can see who added them. The deleted
 * admin's session stops working on its next request (requireAdmin re-reads
 * the admins row every time).
 */
export async function deleteSubAdmin(req, res, next) {
  try {
    if (!(await hasRoleColumn())) return unavailable(res)
    const [result] = await pool.query(`DELETE FROM admins WHERE id = ? AND role = 'sub'`, [req.params.id])
    if (!result.affectedRows) {
      return res.status(404).json({ status: 'error', error: 'Sub-admin not found' })
    }
    res.json({ id: Number(req.params.id), deleted: true })
  } catch (err) {
    next(err)
  }
}
