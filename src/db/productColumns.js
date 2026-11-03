import pool from '../config/db.js'

/**
 * The `products` column names, probed once and shared by every listing query.
 *
 * Reset by the background image-flags migration when it finishes
 * (ensureSchema.js), so listings switch to the new columns without a restart.
 */
let cached = null

export function getProductColumnNames() {
  cached ??= pool
    .query(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'products'`,
    )
    .then(([rows]) => rows.map((row) => row.name))
    .catch((err) => {
      cached = null // don't keep a failed probe — try again on the next request
      throw err
    })
  return cached
}

export function resetProductColumnNames() {
  cached = null
}
