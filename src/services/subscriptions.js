import pool from '../config/db.js'

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000

let hasExpiryColumnPromise = null
let sweepTimer = null

async function hasSubscriptionExpiryColumn() {
  if (!hasExpiryColumnPromise) {
    hasExpiryColumnPromise = pool
      .query(
        `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND table_name = 'merchants'
           AND column_name = 'subscription_expires_at'`,
      )
      .then(([rows]) => Number(rows[0]?.n ?? 0) > 0)
      .catch((err) => {
        hasExpiryColumnPromise = null
        throw err
      })
  }
  return hasExpiryColumnPromise
}

export async function suspendExpiredSubscriptions({ merchantId } = {}) {
  if (!(await hasSubscriptionExpiryColumn())) return 0

  const values = []
  let merchantFilter = ''
  if (merchantId != null) {
    merchantFilter = ' AND id = ?'
    values.push(merchantId)
  }

  const [result] = await pool.query(
    `UPDATE merchants
        SET status = 'suspended'
      WHERE status <> 'suspended'
        AND subscription_expires_at IS NOT NULL
        AND subscription_expires_at < CURDATE()
        ${merchantFilter}`,
    values,
  )
  return Number(result.affectedRows ?? 0)
}

export async function enforceMerchantSubscription(row) {
  if (!row) return row
  const affected = await suspendExpiredSubscriptions({ merchantId: row.id })
  return affected ? { ...row, status: 'suspended' } : row
}

export function startSubscriptionExpirySweep() {
  if (sweepTimer) return sweepTimer

  const run = async () => {
    try {
      const count = await suspendExpiredSubscriptions()
      if (count > 0) {
        console.log(`[subscriptions] suspended ${count} expired merchant subscription(s)`)
      }
    } catch (err) {
      console.warn(
        `[subscriptions] could not sweep expired subscriptions: ${err.sqlMessage || err.message}`,
      )
    }
  }

  void run()
  const interval = Math.max(
    60 * 1000,
    Number(process.env.SUBSCRIPTION_SWEEP_INTERVAL_MS) || DEFAULT_SWEEP_INTERVAL_MS,
  )
  sweepTimer = setInterval(run, interval)
  sweepTimer.unref?.()
  return sweepTimer
}
