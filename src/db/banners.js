import pool from '../config/db.js'

/**
 * merchant_banners support shared by the merchant and storefront controllers.
 */

/** Every column a banner listing needs — everything except the image bytes. */
export const BANNER_LIST_COLUMNS = 'id, title, link_type, link_id, position, is_active, updated_at'

let tableExists = null

/**
 * Whether this database has the merchant_banners table.
 *
 * The API creates it at boot (ensureSchema.js) and `npm run db:add-banners`
 * does the same by hand. But a database user without CREATE rights, or a boot
 * that couldn't reach the database, must still serve every storefront — so
 * banner reads check first and treat a missing table as "no banners".
 *
 * Cached per process, like the column probes in the controllers: a table added
 * while the API is running is picked up on restart.
 */
export async function bannersAvailable() {
  if (tableExists === null) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'merchant_banners'`,
    )
    tableExists = Number(rows[0].n) > 0
  }
  return tableExists
}
