import pool from '../config/db.js'

/**
 * Service status board for the Super Admin overview. These are NOT auto-measured
 * (there's no infra-monitoring integration) — they're entries the Super Admin
 * maintains by hand, so every value is real, admin-entered data. Full CRUD,
 * admin-gated + CSRF-protected (mounted behind requireAdmin in app.js).
 */
const STATUSES = ['operational', 'degraded', 'down']
const num = (v) => Number(v ?? 0)

const mapService = (row) => ({
  id: row.id,
  name: row.name,
  status: row.status,
  uptime: num(row.uptime),
})

/** Validate + normalize a service payload. Returns { error } or clean fields. */
function parse(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return { error: 'Service name is required.' }
  if (name.length > 100) return { error: 'Service name is too long.' }
  if (!STATUSES.includes(body.status)) return { error: 'Invalid status.' }
  const uptime = Number(body.uptime)
  if (!Number.isFinite(uptime) || uptime < 0 || uptime > 100)
    return { error: 'Uptime must be between 0 and 100.' }
  return { name, status: body.status, uptime: Math.round(uptime * 100) / 100 }
}

const findById = async (id) =>
  (
    await pool.query(
      'SELECT id, name, status, uptime FROM service_status WHERE id = ?',
      [id],
    )
  )[0][0]

// GET /api/services
export async function listServices(req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, status, uptime FROM service_status ORDER BY position, id',
    )
    res.json(rows.map(mapService))
  } catch (err) {
    next(err)
  }
}

// POST /api/services
export async function createService(req, res, next) {
  try {
    const v = parse(req.body ?? {})
    if (v.error) return res.status(400).json({ status: 'error', error: v.error })
    const [[{ nextPos }]] = await pool.query(
      'SELECT COALESCE(MAX(position) + 1, 0) AS nextPos FROM service_status',
    )
    const [result] = await pool.query(
      'INSERT INTO service_status (name, status, uptime, position) VALUES (?, ?, ?, ?)',
      [v.name, v.status, v.uptime, nextPos],
    )
    res.status(201).json(mapService(await findById(result.insertId)))
  } catch (err) {
    next(err)
  }
}

// PATCH /api/services/:id
export async function updateService(req, res, next) {
  try {
    const { id } = req.params
    if (!(await findById(id)))
      return res.status(404).json({ status: 'error', error: 'Service not found' })
    const v = parse(req.body ?? {})
    if (v.error) return res.status(400).json({ status: 'error', error: v.error })
    await pool.query(
      'UPDATE service_status SET name = ?, status = ?, uptime = ? WHERE id = ?',
      [v.name, v.status, v.uptime, id],
    )
    res.json(mapService(await findById(id)))
  } catch (err) {
    next(err)
  }
}

// DELETE /api/services/:id
export async function deleteService(req, res, next) {
  try {
    const [result] = await pool.query(
      'DELETE FROM service_status WHERE id = ?',
      [req.params.id],
    )
    if (!result.affectedRows)
      return res.status(404).json({ status: 'error', error: 'Service not found' })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
}
