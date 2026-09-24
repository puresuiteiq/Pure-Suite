import pool from '../config/db.js'

/**
 * The authenticated merchant's own notifications — built from their real
 * activity (their orders, their reviews, their subscription expiry), not canned
 * messages. Mirrors the Super Admin feed but scoped to req.merchantId, with
 * per-merchant read/dismiss state in merchant_notification_states.
 */
const FEED_LIMIT = 12
const DAY_MS = 24 * 60 * 60 * 1000

// Cached check that merchants.subscription_expires_at is migrated in, so the
// expiry lookup is skipped (rather than erroring the feed) if it isn't.
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

// Cached check that the state table exists (pre-migration safe: with no table,
// nothing is read/dismissed yet, so the feed still lists everything).
let stateTable
async function hasStateTable() {
  if (stateTable === undefined) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'merchant_notification_states'`,
    )
    stateTable = rows[0].n > 0
  }
  return stateTable
}

// IQD only, whole dinars; unit follows the caller's UI language (?lang=).
const money = (v, lang) =>
  `${Math.round(Number(v ?? 0)).toLocaleString('en-US')}\u00A0${lang === 'en' ? 'IQD' : 'د.ع'}`

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

/** This merchant's own subscription expiry (within 7 days / lapsed) → event. */
async function myExpiryEvent(merchantId) {
  if (!(await hasExpiryColumn())) return []
  const [rows] = await pool.query(
    `SELECT subscription_expires_at FROM merchants
     WHERE id = ? AND status <> 'suspended'
       AND subscription_expires_at IS NOT NULL
       AND subscription_expires_at <= (CURDATE() + INTERVAL 7 DAY)`,
    [merchantId],
  )
  if (!rows.length) return []
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const expires = new Date(rows[0].subscription_expires_at)
  const days = Math.round((expires - startOfToday) / DAY_MS)
  const message =
    days > 0
      ? `Your subscription expires in ${days} day${days === 1 ? '' : 's'} — renew to avoid interruption.`
      : days === 0
        ? `Your subscription expires today — renew to avoid interruption.`
        : `Your subscription expired ${-days} day${days === -1 ? '' : 's'} ago — renew now.`
  return [{ id: `subexpiry-${merchantId}`, at: rows[0].subscription_expires_at, title: 'Subscription expiring', message }]
}

// GET /api/merchant/notifications
export async function listMyNotifications(req, res, next) {
  try {
    const lang = String(req.query.lang || 'en').split('-')[0]
    const merchantId = req.merchantId

    const [[orders], [reviews], expiry] = await Promise.all([
      pool.query(
        `SELECT id, merchant_order_no, total, created_at
         FROM orders WHERE merchant_id = ?
           AND status NOT IN ('cancelled', 'failed')
         ORDER BY created_at DESC LIMIT 10`,
        [merchantId],
      ),
      pool.query(
        `SELECT id, customer_name, rating, created_at
         FROM reviews WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 8`,
        [merchantId],
      ),
      myExpiryEvent(merchantId),
    ])

    const events = [
      ...expiry,
      ...orders.map((o) => ({
        id: `order-${o.id}`,
        at: o.created_at,
        title: 'New order',
        message: o.merchant_order_no != null
          ? `New order #${o.merchant_order_no} (${money(o.total, lang)}).`
          : `New order (${money(o.total, lang)}).`,
      })),
      ...reviews.map((r) => ({
        id: `review-${r.id}`,
        at: r.created_at,
        title: 'New review',
        message: `${r.customer_name} left a ${r.rating}★ review.`,
      })),
    ]

    const eventIds = events.map((e) => e.id)
    const [states] = (await hasStateTable()) && eventIds.length
      ? await pool.query(
          `SELECT event_id, read_at, deleted_at FROM merchant_notification_states
           WHERE merchant_id = ? AND event_id IN (${eventIds.map(() => '?').join(',')})`,
          [merchantId, ...eventIds],
        )
      : [[]]
    const stateByEvent = new Map(states.map((s) => [s.event_id, s]))

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

async function setState(req, res, next, column) {
  try {
    if (!(await hasStateTable())) return res.json({ ok: true })
    const eventId = String(req.params.id || '')
    if (!/^(review|order|subexpiry)-\d+$/.test(eventId)) {
      return res.status(400).json({ status: 'error', error: 'Invalid notification' })
    }
    // `column` is a hardcoded literal from our own callers, never user input.
    await pool.query(
      `INSERT INTO merchant_notification_states (merchant_id, event_id, ${column}) VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE ${column} = NOW()`,
      [req.merchantId, eventId],
    )
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
}

export const markMyNotificationRead = (req, res, next) => setState(req, res, next, 'read_at')
export const deleteMyNotification = (req, res, next) => setState(req, res, next, 'deleted_at')
