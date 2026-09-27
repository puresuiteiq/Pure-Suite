import test from 'node:test'
import assert from 'node:assert/strict'
import { adminRole, canManageMerchant, isSuperAdmin, stripSubAdminFields } from '../src/utils/adminRoles.js'

/**
 * Sub-admin rules. The failure that matters is a sub-admin reaching a merchant
 * that isn't theirs, or suspending one — both are checked here, on the same
 * functions the merchants controller calls.
 */

const main = { id: 1, role: 'super' }
const sub = { id: 7, role: 'sub' }

test('adminRole: only an explicit "sub" is a sub-admin', () => {
  assert.equal(adminRole({ role: 'sub' }), 'sub')
  assert.equal(adminRole({ role: 'super' }), 'super')
  // No role column yet (before db:add-admin-roles): every admin is the owner.
  assert.equal(adminRole({}), 'super')
  assert.equal(adminRole({ role: 'anything-else' }), 'super')
  assert.equal(isSuperAdmin(sub), false)
})

test('canManageMerchant: the main admin manages every merchant', () => {
  assert.equal(canManageMerchant(main, { id: 3, created_by_admin_id: 7 }), true)
  assert.equal(canManageMerchant(main, { id: 3, created_by_admin_id: null }), true)
})

test('canManageMerchant: a sub-admin manages only the merchants they added', () => {
  assert.equal(canManageMerchant(sub, { id: 3, created_by_admin_id: 7 }), true)
  // mysql2 may hand the id back as a string.
  assert.equal(canManageMerchant(sub, { id: 3, created_by_admin_id: '7' }), true)
  assert.equal(canManageMerchant(sub, { id: 4, created_by_admin_id: 8 }), false)
  // Added by the main admin, or before sub-admins existed: not theirs.
  assert.equal(canManageMerchant(sub, { id: 5, created_by_admin_id: null }), false)
  assert.equal(canManageMerchant(sub, undefined), false)
})

test('stripSubAdminFields: a sub-admin cannot set a status (suspend)', () => {
  assert.deepEqual(stripSubAdminFields(sub, { name: 'A', status: 'suspended' }), { name: 'A' })
  assert.deepEqual(stripSubAdminFields(main, { name: 'A', status: 'suspended' }), {
    name: 'A',
    status: 'suspended',
  })
})
