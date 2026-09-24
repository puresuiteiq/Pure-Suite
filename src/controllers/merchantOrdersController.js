import pool from '../config/db.js'

/**
 * Order history for the authenticated merchant — their own orders only, newest
 * first, each with its line items and the customer who placed it. Orders are
 * real rows recorded when customers order on the storefront (nothing seeded).
 */
const mapOrder = (row) => ({
  id: row.id,
  orderNo: row.merchant_order_no != null ? Number(row.merchant_order_no) : null,
  total: Number(row.total),
  status: row.status,
  createdAt: row.created_at,
  // Customer columns are optional (added by a migration) — default to null.
  customerName: row.customer_name ?? null,
  customerPhone: row.customer_phone ?? null,
  // Service method + delivery fee (optional columns, default null).
  serviceMethod: row.service_method ?? null,
  deliveryZone: row.delivery_zone ?? null,
  deliveryFee: row.delivery_fee != null ? Number(row.delivery_fee) : null,
  tableNumber: row.table_number ?? null,
  items: [],
})

// GET /api/merchant/orders   (merchantId from token)
export async function getMyOrders(req, res, next) {
  try {
    // SELECT * so this keeps working if the customer columns aren't migrated yet
    // (orders has no heavy columns, so it's cheap); mapOrder defaults them.
    const [rows] = await pool.query(
      'SELECT * FROM orders WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT 100',
      [req.merchantId],
    )
    if (!rows.length) return res.json([])

    const orders = rows.map(mapOrder)
    const byId = new Map(orders.map((o) => [o.id, o]))

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

/**
 * Allowed status moves.
 *
 * Orders are created 'pending'. A merchant confirms one when they have made
 * and handed it over, or cancels it. 'failed' exists for an order that could
 * not be fulfilled at all.
 *
 * Terminal states stay terminal, with one exception: a completed order can
 * still be cancelled, because mistakes and refunds happen after the fact and
 * the alternative is a permanently wrong revenue figure.
 */
const ALLOWED_TRANSITIONS = {
  pending: ['completed', 'cancelled', 'failed'],
  completed: ['cancelled'],
  cancelled: [],
  failed: [],
}

// PATCH /api/merchant/orders/:id   { status }
/**
 * The merchant is taken from the token and the UPDATE is scoped to it, so this
 * can only ever move the caller's own orders.
 */
export async function updateMyOrderStatus(req, res, next) {
  try {
    const next_ = typeof req.body?.status === 'string' ? req.body.status : ''
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, next_)) {
      return res.status(400).json({
        status: 'error',
        error: `status must be one of: ${Object.keys(ALLOWED_TRANSITIONS).join(', ')}`,
      })
    }

    const [rows] = await pool.query(
      'SELECT status FROM orders WHERE id = ? AND merchant_id = ?',
      [req.params.id, req.merchantId],
    )
    if (!rows.length) {
      return res.status(404).json({ status: 'error', error: 'Order not found' })
    }

    const current = rows[0].status
    if (current === next_) {
      return res.json({ id: Number(req.params.id), status: current })
    }
    if (!ALLOWED_TRANSITIONS[current].includes(next_)) {
      return res.status(409).json({
        status: 'error',
        error: `An order that is ${current} cannot be marked ${next_}.`,
      })
    }

    await pool.query('UPDATE orders SET status = ? WHERE id = ? AND merchant_id = ?', [
      next_,
      req.params.id,
      req.merchantId,
    ])
    res.json({ id: Number(req.params.id), status: next_ })
  } catch (err) {
    next(err)
  }
}
