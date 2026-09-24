import { Router } from 'express'
import { pingDatabase } from '../config/db.js'

const router = Router()

/**
 * Produce a human-readable reason from a DB error. mysql2 surfaces a `code`
 * (e.g. ECONNREFUSED, ER_ACCESS_DENIED_ERROR); a refused localhost connection
 * arrives as an AggregateError whose top-level `message` is empty, so fall back
 * to the nested errors.
 */
function describeError(err) {
  if (err.code) return err.code
  if (Array.isArray(err.errors) && err.errors.length) {
    return err.errors.map((e) => e.code || e.message).join('; ')
  }
  return err.message || 'Database connection failed'
}

/**
 * GET /api/health
 * Confirms the API is up and the database connection is established.
 * Returns 200 when the DB responds, 503 when it does not.
 */
router.get('/health', async (req, res) => {
  const payload = {
    status: 'ok',
    service: 'restaurant-saas-backend',
    database: 'connected',
    timestamp: new Date().toISOString(),
  }

  try {
    await pingDatabase()
    res.json(payload)
  } catch (err) {
    res.status(503).json({
      ...payload,
      status: 'error',
      database: 'disconnected',
      error: describeError(err),
    })
  }
})

export default router
