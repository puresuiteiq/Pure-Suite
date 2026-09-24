import pool from '../config/db.js'

/**
 * Platform-wide reviews for Super Admin oversight — every review across all
 * merchants, joined with the restaurant name. Admin-gated.
 */
// GET /api/admin/reviews
export async function listAllReviews(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT r.id, r.merchant_id, m.business_name, r.customer_name, r.rating,
              r.comment, DATE_FORMAT(r.created_at, '%Y-%m-%d') AS date
       FROM reviews r
       JOIN merchants m ON m.id = r.merchant_id
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 500`,
    )
    res.json(
      rows.map((r) => ({
        id: r.id,
        merchantId: r.merchant_id,
        merchantName: r.business_name,
        customerName: r.customer_name,
        rating: Number(r.rating),
        comment: r.comment ?? '',
        date: r.date,
      })),
    )
  } catch (err) {
    next(err)
  }
}

// DELETE /api/admin/reviews/:id
/**
 * Remove a review. Super Admin only.
 *
 * Deliberately not offered to merchants. The storefront's star rating is
 * computed from these rows, so a merchant who could delete them could curate
 * their own public rating — the review system would stop meaning anything. A
 * merchant who wants a review gone asks the platform, which is a person making
 * a judgement rather than a button that erases criticism.
 *
 * Until now nobody could delete one at all: the only lever was the merchant's
 * all-or-nothing reviews_enabled toggle, which hides every review including the
 * good ones. With unauthenticated review submission that left spam permanent.
 */
export async function deleteReview(req, res, next) {
  try {
    const [result] = await pool.query('DELETE FROM reviews WHERE id = ?', [req.params.id])
    if (!result.affectedRows) {
      return res.status(404).json({ status: 'error', error: 'Review not found' })
    }
    res.json({ id: Number(req.params.id), deleted: true })
  } catch (err) {
    next(err)
  }
}
