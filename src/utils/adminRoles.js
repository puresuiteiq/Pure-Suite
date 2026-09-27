/**
 * Admin roles: who may do what to which merchant.
 *
 *  - 'super' — the platform owner. Everything, on every merchant.
 *  - 'sub'   — a sub-admin. Adds merchants, and manages only the ones they
 *              added: edit, reset the password, open their panel, renew.
 *              Never deletes, suspends, or cancels a subscription, and sees
 *              none of the platform pages (revenue, plans, orders, …).
 *
 * Pure (no database), so the rules are unit-tested directly.
 */

export const ADMIN_ROLES = ['super', 'sub']

/**
 * An admins row → its role. Anything but an explicit 'sub' is 'super': an
 * install that hasn't run db:add-admin-roles has no role column, and every
 * admin there was created as the platform owner.
 */
export function adminRole(row) {
  return row?.role === 'sub' ? 'sub' : 'super'
}

export const isSuperAdmin = (admin) => adminRole(admin) === 'super'

/** May this admin see and manage this merchant (a merchants row)? */
export function canManageMerchant(admin, merchantRow) {
  if (!merchantRow) return false
  if (isSuperAdmin(admin)) return true
  return (
    merchantRow.created_by_admin_id != null &&
    Number(merchantRow.created_by_admin_id) === Number(admin?.id)
  )
}

/**
 * Merchant fields a sub-admin's write never touches, whatever the body says.
 * `status` is how a merchant is suspended — that is the main admin's call.
 */
export function stripSubAdminFields(admin, body) {
  if (isSuperAdmin(admin) || !body || typeof body !== 'object') return body
  const { status: _status, ...rest } = body
  return rest
}
