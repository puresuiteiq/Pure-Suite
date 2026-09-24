import pool from '../config/db.js'

function rowToReview(row) {
  return {
    id: row.id,
    customerName: row.customer_name,
    rating: Number(row.rating),
    comment: row.comment ?? '',
    date: row.date, // formatted YYYY-MM-DD by the query
  }
}

// GET /api/merchant/reviews   (merchantId from token)
export async function getMyReviews(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT id, customer_name, rating, comment,
              DATE_FORMAT(created_at, '%Y-%m-%d') AS date
       FROM reviews
       WHERE merchant_id = ?
       ORDER BY created_at DESC, id DESC`,
      [req.merchantId],
    )
    res.json(rows.map(rowToReview))
  } catch (err) {
    next(err)
  }
}
