import pool from '../config/db.js'

/**
 * Fallback plan prices (monthly IQD) used ONLY if the `plans` table hasn't been
 * migrated in yet. Once plans live in the DB, MRR reads from there.
 */
const PLAN_PRICES = {
  Starter: 65000,
  Growth: 195000,
  Enterprise: 390000,
}

const num = (v) => Number(v ?? 0)

/**
 * Load plans as `{ name, monthly }` where `monthly` is the price normalized to a
 * monthly-equivalent (`price * 30 / period_days`), so yearly/custom-period plans
 * still contribute a sensible amount to Monthly Recurring Revenue. Falls back to
 * the hardcoded config when the `plans` table doesn't exist yet.
 */
async function loadPlans() {
  try {
    const [rows] = await pool.query(
      'SELECT name, price, period_days FROM plans ORDER BY position, id',
    )
    if (rows.length) {
      return rows.map((r) => ({
        name: r.name,
        monthly: Math.round((Number(r.price) * 30) / (Number(r.period_days) || 30)),
      }))
    }
  } catch {
    // plans table not migrated yet — fall through to config.
  }
  return Object.entries(PLAN_PRICES).map(([name, price]) => ({ name, monthly: price }))
}

/**
 * Format a period-over-period change only when a real comparison exists.
 * A zero baseline cannot produce a meaningful percentage, so returning null
 * prevents the UI from inventing a misleading “+100%” trend.
 */
function trend(current, previous) {
  if (!previous) return null
  const pct = ((current - previous) / previous) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Build a 30-day skeleton (oldest→newest) and fill counts from the DB rows. */
function buildOrdersTrend(rows) {
  const counts = new Map(rows.map((r) => [r.day, num(r.c)]))
  const out = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    out.push({
      date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      orders: counts.get(ymd(d)) ?? 0,
    })
  }
  return out
}

// GET /api/overview
export async function getOverview(req, res, next) {
  try {
    const [
      [planCounts],
      [ordersToday],
      [ordersYesterday],
      [reviewsAgg],
      [chartRows],
      plans,
    ] = await Promise.all([
      // Active merchants grouped by plan; MRR is summed from plan prices in JS.
      pool.query(
        `SELECT plan, COUNT(*) AS c FROM merchants WHERE status = 'active' GROUP BY plan`,
      ),
      // The three order aggregates below exclude cancelled/failed. Orders are
      // created as 'pending' and the merchant confirms them, so "orders placed"
      // is the honest measure here — not "orders fulfilled", which would read 0
      // every morning until merchants started clicking.
      pool.query(
        `SELECT COUNT(*) AS c FROM orders
         WHERE created_at >= CURDATE() AND status NOT IN ('cancelled', 'failed')`,
      ),
      pool.query(
        `SELECT COUNT(*) AS c FROM orders
         WHERE created_at >= (CURDATE() - INTERVAL 1 DAY) AND created_at < CURDATE()
           AND status NOT IN ('cancelled', 'failed')`,
      ),
      // Total reviews (real oversight metric) + last-30d vs prior-30d for trend.
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN created_at >= (CURDATE() - INTERVAL 30 DAY) THEN 1 END) AS last30,
          COUNT(CASE WHEN created_at >= (CURDATE() - INTERVAL 60 DAY)
                      AND created_at <  (CURDATE() - INTERVAL 30 DAY) THEN 1 END) AS prev30
        FROM reviews`),
      pool.query(`
        SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS c
        FROM orders
        WHERE created_at >= (CURDATE() - INTERVAL 29 DAY)
          AND status NOT IN ('cancelled', 'failed')
        GROUP BY day ORDER BY day`),
      loadPlans(),
    ])

    const priceByPlan = new Map(plans.map((p) => [p.name, p.monthly]))
    const activeCount = planCounts.reduce((sum, r) => sum + num(r.c), 0)
    const mrr = planCounts.reduce((sum, r) => sum + num(r.c) * (priceByPlan.get(r.plan) ?? 0), 0)
    const today = num(ordersToday[0].c)
    const yesterday = num(ordersYesterday[0].c)
    const reviewsTotal = num(reviewsAgg[0].total)
    const reviewsLast30 = num(reviewsAgg[0].last30)
    const reviewsPrev30 = num(reviewsAgg[0].prev30)

    const stats = [
      {
        key: 'merchants',
        label: 'Active Merchants',
        value: activeCount.toLocaleString('en-US'),
        // Merchant status history is not audited, so there is no trustworthy
        // “last month” baseline for this current-state count.
        trend: null,
        icon: 'store',
      },
      {
        key: 'orders',
        label: 'Orders Today',
        value: today.toLocaleString('en-US'),
        trend: trend(today, yesterday),
        icon: 'activity',
      },
      {
        key: 'mrr',
        label: 'Platform MRR',
        // The number only; `unit: 'currency'` tells the frontend to append the
        // dinar suffix in the viewer's own language (IQD / د.ع).
        value: Math.round(mrr).toLocaleString('en-US'),
        unit: 'currency',
        // MRR is derived from the current plan configuration; without billing
        // history, a month-over-month percentage would not be real data.
        trend: null,
        icon: 'dashboard',
      },
      {
        key: 'reviews',
        label: 'Total Reviews',
        value: reviewsTotal.toLocaleString('en-US'),
        trend: trend(reviewsLast30, reviewsPrev30),
        icon: 'star',
      },
    ]

    res.json({
      stats,
      ordersTrend: buildOrdersTrend(chartRows),
    })
  } catch (err) {
    next(err)
  }
}

// GET /api/overview/revenue
/**
 * The plan-by-plan derivation of Platform MRR: what the KPI on the overview is
 * actually made of. Every number comes from live merchant records — the counts
 * are grouped straight from the table, the prices are PLAN_PRICES config, and
 * nothing is estimated.
 */
export async function getRevenue(req, res, next) {
  try {
    const [[rows], planList] = await Promise.all([
      pool.query(`
        SELECT plan, COUNT(*) AS merchants
        FROM merchants
        WHERE status = 'active'
        GROUP BY plan`),
      loadPlans(),
    ])

    const counts = new Map(rows.map((r) => [r.plan, num(r.merchants)]))
    const known = new Set(planList.map((p) => p.name))

    // Every plan gets a row, including ones nobody is on — "Growth: 0 merchants"
    // is real information for a platform owner, not an empty state. `price` here
    // is the monthly-equivalent so the subtotals sum to the MRR headline.
    const priced = planList.map(({ name, monthly }) => {
      const merchants = counts.get(name) ?? 0
      return { plan: name, price: monthly, merchants, subtotal: merchants * monthly, unpriced: false }
    })

    // A merchant on a plan not in the table (renamed/deleted) contributes 0.
    // Surfacing those rows keeps the breakdown reconcilable with the headline.
    const unpriced = rows
      .filter((r) => r.plan && !known.has(r.plan))
      .map((r) => ({
        plan: r.plan,
        price: 0,
        merchants: num(r.merchants),
        subtotal: 0,
        unpriced: true,
      }))

    const plans = [...priced, ...unpriced].sort((a, b) => b.subtotal - a.subtotal)

    res.json({
      mrr: plans.reduce((sum, p) => sum + p.subtotal, 0),
      activeMerchants: plans.reduce((sum, p) => sum + p.merchants, 0),
      plans,
    })
  } catch (err) {
    next(err)
  }
}
