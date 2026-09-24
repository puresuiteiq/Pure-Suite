import pool from '../config/db.js'

const num = (v) => Number(v ?? 0)

/**
 * Real dashboard stats for the logged-in merchant (from the token). Computed
 * live from orders + reviews so the numbers reflect actual, persisted activity.
 */
// GET /api/merchant/overview
export async function getMyOverview(req, res, next) {
  try {
    const id = req.merchantId

    const [[orders], [reviews]] = await Promise.all([
      pool.query(
        // Excludes cancelled/failed orders. Every pre-existing row is
        // 'completed', so this does not move today's figures; it only stops a
        // cancelled order still counting as revenue.
        `SELECT COUNT(*) AS ordersToday,
                COALESCE(SUM(total), 0) AS revenueToday
         FROM orders
         WHERE merchant_id = ? AND created_at >= CURDATE()
           AND status NOT IN ('cancelled', 'failed')`,
        [id],
      ),
      pool.query(
        `SELECT COUNT(*) AS reviewsCount, COALESCE(AVG(rating), 0) AS avgRating
         FROM reviews WHERE merchant_id = ?`,
        [id],
      ),
    ])

    res.json({
      ordersToday: num(orders[0].ordersToday),
      revenueToday: num(orders[0].revenueToday),
      reviewsCount: num(reviews[0].reviewsCount),
      avgRating: num(reviews[0].avgRating),
    })
  } catch (err) {
    next(err)
  }
}
