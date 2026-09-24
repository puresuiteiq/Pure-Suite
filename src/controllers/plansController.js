import pool from '../config/db.js'
import { ERROR_CODES, errorBody } from '../utils/errorCodes.js'

/**
 * Subscription plans the Super Admin designs. merchants reference a plan by its
 * `name` string, so renaming a plan cascades to its merchants. Admin-gated + CSRF
 * (mounted behind requireAdmin in app.js). Prices are IQD per billing period.
 */

/** Parse the JSON features column into a clean string array. */
function parseFeatures(value) {
  if (!value) return []
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed.filter((f) => typeof f === 'string' && f.trim()) : []
  } catch {
    return []
  }
}

const mapPlan = (row) => ({
  id: row.id,
  name: row.name,
  price: Number(row.price),
  periodDays: Number(row.period_days),
  description: row.description ?? '',
  features: parseFeatures(row.features),
  active: Boolean(row.active),
})

/** Validate + normalize a plan payload. Returns { error } or clean fields. */
function parse(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return { error: 'Plan name is required.' }
  if (name.length > 80) return { error: 'Plan name is too long.' }
  const price = Number(body.price)
  if (!Number.isFinite(price) || price < 0) return { error: 'Price must be 0 or more.' }
  const periodDays = Math.floor(Number(body.periodDays))
  if (!Number.isInteger(periodDays) || periodDays < 1) return { error: 'Billing period must be at least 1 day.' }
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 255) : null
  const features = Array.isArray(body.features)
    ? body.features.map((f) => String(f).trim()).filter(Boolean)
    : []
  const active = body.active === undefined ? true : Boolean(body.active)
  return { name, price: Math.round(price), periodDays, description: description || null, features, active }
}

const findById = async (id) =>
  (await pool.query('SELECT * FROM plans WHERE id = ?', [id]))[0][0]

// GET /api/plans
export async function listPlans(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT * FROM plans ORDER BY position, id')
    res.json(rows.map(mapPlan))
  } catch (err) {
    next(err)
  }
}

// POST /api/plans
export async function createPlan(req, res, next) {
  try {
    const v = parse(req.body ?? {})
    if (v.error) return res.status(400).json({ status: 'error', error: v.error })
    const [[{ nextPos }]] = await pool.query(
      'SELECT COALESCE(MAX(position) + 1, 0) AS nextPos FROM plans',
    )
    const [result] = await pool.query(
      `INSERT INTO plans (name, price, period_days, description, features, active, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [v.name, v.price, v.periodDays, v.description, JSON.stringify(v.features), v.active ? 1 : 0, nextPos],
    )
    res.status(201).json(mapPlan(await findById(result.insertId)))
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ status: 'error', error: 'A plan with this name already exists.' })
    }
    next(err)
  }
}

// PATCH /api/plans/:id
export async function updatePlan(req, res, next) {
  try {
    const existing = await findById(req.params.id)
    if (!existing) return res.status(404).json({ status: 'error', error: 'Plan not found' })
    const v = parse(req.body ?? {})
    if (v.error) return res.status(400).json({ status: 'error', error: v.error })

    await pool.query(
      `UPDATE plans SET name = ?, price = ?, period_days = ?, description = ?, features = ?, active = ?
       WHERE id = ?`,
      [v.name, v.price, v.periodDays, v.description, JSON.stringify(v.features), v.active ? 1 : 0, req.params.id],
    )
    // Keep merchant plan references in sync when a plan is renamed.
    if (existing.name !== v.name) {
      await pool.query('UPDATE merchants SET plan = ? WHERE plan = ?', [v.name, existing.name])
    }
    res.json(mapPlan(await findById(req.params.id)))
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ status: 'error', error: 'A plan with this name already exists.' })
    }
    next(err)
  }
}

// DELETE /api/plans/:id
/**
 * Refuses while merchants are still on the plan.
 *
 * merchants.plan holds the plan NAME as a plain VARCHAR, not a foreign key to
 * plans.id — that is deliberate (the Super Admin designs plans, so renaming one
 * has to cascade by name), but it means the database will not stop this delete.
 * Without the check the plan simply vanished and every merchant on it kept a
 * name that no longer resolved: they silently contributed 0 to MRR, showed as
 * "unpriced" on the revenue page, and their subscription renewals quietly did
 * nothing, because renewMerchant looks the billing period up by that same name.
 *
 * The count therefore has to be taken by name, not by id — the id is not stored
 * anywhere on the merchant, so checking it would make the guard a no-op.
 */
export async function deletePlan(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT name FROM plans WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ status: 'error', error: 'Plan not found' })
    const planName = rows[0].name

    const [[usage]] = await pool.query(
      'SELECT COUNT(*) AS n FROM merchants WHERE plan = ?',
      [planName],
    )
    const assigned = Number(usage.n)
    if (assigned > 0) {
      return res.status(409).json(
        errorBody(
          `${assigned} merchant${assigned === 1 ? ' is' : 's are'} still on the ` +
            `"${planName}" plan. Move them to another plan first.`,
          ERROR_CODES.PLAN_IN_USE,
          { count: assigned, plan: planName },
        ),
      )
    }

    const [result] = await pool.query('DELETE FROM plans WHERE id = ?', [req.params.id])
    if (!result.affectedRows) return res.status(404).json({ status: 'error', error: 'Plan not found' })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
}
