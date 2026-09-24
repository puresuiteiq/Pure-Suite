import 'dotenv/config'

/**
 * (Retired) This script used to seed demo merchants, orders and service-status
 * rows so the Super Admin overview looked populated. The platform is now fully
 * real-data-driven — nothing here injects mock data anymore:
 *
 *   - Merchants        → created by the Super Admin (Merchants Management).
 *   - Orders           → recorded when customers place them on a storefront.
 *   - Reviews          → submitted by real customers.
 *   - Service Status   → maintained by the Super Admin (add/edit/remove).
 *
 * The npm script is kept so `db:seed-overview` doesn't error, but it's a no-op.
 * Delete it (and the package.json entry) whenever convenient.
 */
console.log(
  'Nothing to seed — the platform is fully real-data-driven now.\n' +
    'Add merchants and services from the Super Admin dashboard; orders and\n' +
    'reviews are recorded from real storefront activity.',
)
