import pool from '../config/db.js'

/**
 * Orders list for the Super Admin (admin-gated). Orders are real rows recorded
 * when customers place them on a storefront — nothing seeded. Returns the most
 * recent orders across all merchants, newest first, each with its line items.
 */
const mapOrder = (row) => ({
  id: row.id,
  // The per-merchant number the customer/restaurant reference (null on legacy
  // rows created before the number existed and not yet backfilled).
  orderNo: row.merchant_order_no != null ? Number(row.merchant_order_no) : null,
  merchantId: row.merchant_id,
  restaurant: row.business_name,
  total: Number(row.total),
  status: row.status,
  createdAt: row.created_at,
  // Service method + delivery fee (optional columns, default null).
  serviceMethod: row.service_method ?? null,
  deliveryZone: row.delivery_zone ?? null,
  deliveryFee: row.delivery_fee != null ? Number(row.delivery_fee) : null,
  tableNumber: row.table_number ?? null,
  items: [],
})

// GET /api/orders
export async function listOrders(req, res, next) {
  try {
    // o.* so new optional columns (service_method, delivery_fee, …) are read
    // when present without breaking pre-migration.
    const [rows] = await pool.query(
      `SELECT o.*, m.business_name
       FROM orders o JOIN merchants m ON m.id = o.merchant_id
       ORDER BY o.created_at DESC
       LIMIT 100`,
    )
    if (!rows.length) return res.json([])

    const orders = rows.map(mapOrder)
    const byId = new Map(orders.map((o) => [o.id, o]))

    // Fetch all line items for the listed orders in one query, then attach.
    const ids = rows.map((r) => r.id)
    const [items] = await pool.query(
      `SELECT order_id, product_name, quantity, unit_price
       FROM order_items
       WHERE order_id IN (${ids.map(() => '?').join(',')})
       ORDER BY id`,
      ids,
    )
    for (const it of items) {
      byId.get(it.order_id)?.items.push({
        productName: it.product_name,
        quantity: Number(it.quantity),
        unitPrice: Number(it.unit_price),
      })
    }

    res.json(orders)
  } catch (err) {
    next(err)
  }
}
