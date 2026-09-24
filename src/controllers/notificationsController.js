import pool from '../config/db.js'

/**
 * Super Admin notifications — built from real platform activity, not canned
 * messages. We surface the most recent merchant signups, customer reviews and
 * orders, merge them newest-first and show a handful. "Unread" means it
 * happened in the last 24h (there's no per-admin read-tracking table yet), so
 * the badge reflects genuine recent activity.
 */
const FEED_LIMIT = 12
const DAY_MS = 24 * 60 * 60 * 1000

// Cached check that merchants.subscription_expires_at is migrated in, so the
// expiry query is skipped (rather than erroring the whole feed) if it isn't.
let expiryColumn
async function hasExpiryColumn() {
  if (expiryColumn === undefined) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'merchants'
         AND column_name = 'subscription_expires_at'`,
    )
    expiryColumn = rows[0].n > 0
  }
  return expiryColumn
}

/** Merchants expiring within a week (or lapsed in the last 3 days) → events. */
async function expiryEvents() {
  if (!(await hasExpiryColumn())) return []
  const [rows] = await pool.query(
    `SELECT id, business_name, subscription_expires_at
     FROM merchants
     WHERE status <> 'suspended'
       AND subscription_expires_at IS NOT NULL
       AND subscription_expires_at <= (CURDATE() + INTERVAL 7 DAY)
       AND subscription_expires_at >= (CURDATE() - INTERVAL 3 DAY)`,
  )
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  return rows.map((m) => {
    const expires = new Date(m.subscription_expires_at)
    const days = Math.round((expires - startOfToday) / DAY_MS)
    const message =
      days > 0
        ? `${m.business_name}'s subscription expires in ${days} day${days === 1 ? '' : 's'} — remind them to renew.`
        : days === 0
          ? `${m.business_name}'s subscription expires today — remind them to renew.`
          : `${m.business_name}'s subscription expired ${-days} day${days === -1 ? '' : 's'} ago — remind them to renew.`
    return { id: `subexpiry-${m.id}`, at: m.subscription_expires_at, title: 'Subscription expiring', message }
  })
}

/** Human "time ago" from a timestamp. */
function timeAgo(date) {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

// IQD is the platform's only currency and has no minor unit in practice, so
// amounts are whole dinars. Mirrors formatCurrency() on the frontend — the unit
// follows the viewer's language (Latin "IQD" in English, "د.ع" otherwise).
const money = (v, lang) =>
  `${Math.round(Number(v ?? 0)).toLocaleString('en-US')}\u00A0${lang === 'en' ? 'IQD' : 'د.ع'}`

// GET /api/notifications
export async function listNotifications(req, res, next) {
  try {
    // The dinar unit follows the caller's UI language (sent as ?lang=).
    const lang = String(req.query.lang || 'en').split('-')[0]
    const [[merchants], [reviews], [orders], expiring] = await Promise.all([
      pool.query(
        `SELECT id, business_name, plan, status, created_at
         FROM merchants ORDER BY created_at DESC LIMIT 8`,
      ),
      pool.query(
        `SELECT r.id, r.customer_name, r.rating, r.created_at, m.business_name
         FROM reviews r JOIN merchants m ON m.id = r.merchant_id
         ORDER BY r.created_at DESC LIMIT 8`,
      ),
      pool.query(
        `SELECT o.id, o.merchant_order_no, o.total, o.created_at, m.business_name
         FROM orders o JOIN merchants m ON m.id = o.merchant_id
         WHERE o.status NOT IN ('cancelled', 'failed')
         ORDER BY o.created_at DESC LIMIT 8`,
      ),
      expiryEvents(),
    ])

    const events = [
      ...expiring,
      ...merchants.map((m) => ({
        id: `merchant-${m.id}`,
        at: m.created_at,
        title: 'New merchant signup',
        message: `${m.business_name} created an account (${m.plan} plan).`,
      })),
      ...reviews.map((r) => ({
        id: `review-${r.id}`,
        at: r.created_at,
        title: 'New review',
        message: `${r.customer_name} left a ${r.rating}★ review for ${r.business_name}.`,
      })),
      ...orders.map((o) => ({
        id: `order-${o.id}`,
        at: o.created_at,
        title: 'New order',
        message: o.merchant_order_no != null
          ? `${o.business_name} received order #${o.merchant_order_no} (${money(o.total, lang)}).`
          : `${o.business_name} received an order (${money(o.total, lang)}).`,
      })),
    ]

    const eventIds = events.map((event) => event.id)
    const [states] = eventIds.length
      ? await pool.query(
          `SELECT event_id, read_at, deleted_at FROM admin_notification_states
           WHERE admin_id = ? AND event_id IN (${eventIds.map(() => '?').join(',')})`,
          [req.admin.id, ...eventIds],
        )
      : [[]]
    const stateByEvent = new Map(states.map((state) => [state.event_id, state]))

    const feed = events
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, FEED_LIMIT)
      .filter((e) => !stateByEvent.get(e.id)?.deleted_at)
      .map((e) => ({
        id: e.id,
        title: e.title,
        message: e.message,
        time: timeAgo(e.at),
        unread: !stateByEvent.get(e.id)?.read_at && Date.now() - new Date(e.at).getTime() < DAY_MS,
      }))

    res.json(feed)
  } catch (err) {
    next(err)
  }
}

async function setNotificationState(req, res, next, changes) {
  try {
    const eventId = String(req.params.id || '')
    if (!/^(merchant|review|order|subexpiry)-\d+$/.test(eventId)) {
      return res.status(400).json({ status: 'error', error: 'Invalid notification' })
    }
    await pool.query(
      `INSERT INTO admin_notification_states (admin_id, event_id, ${changes.column}) VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE ${changes.column} = NOW()`,
      [req.admin.id, eventId],
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
}

export const markNotificationRead = (req, res, next) => setNotificationState(req, res, next, { column: 'read_at' })
export const deleteNotification = (req, res, next) => setNotificationState(req, res, next, { column: 'deleted_at' })
