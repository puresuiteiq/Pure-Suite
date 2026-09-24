import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveService, SERVICE_METHODS } from '../src/utils/service.js'

/**
 * Service method + delivery fee resolution.
 *
 * The fee is money, and the request comes from a public page, so everything
 * here is about never trusting the submitted values. These cases exist because
 * this logic used to live inside a 200-line transaction where it could not be
 * tested — and a free-delivery hole sat in it unnoticed.
 */

const zoned = {
  delivery: {
    enabled: true,
    zones: [
      { name: 'Center', fee: 2000 },
      { name: 'Karrada', fee: 3000 },
    ],
  },
  dinein: { enabled: true },
  pickup: { enabled: true },
}

test('no configuration means a plain, fee-free order', () => {
  const resolved = resolveService(null, { serviceMethod: 'delivery' })
  assert.equal(resolved.serviceMethod, null)
  assert.equal(resolved.deliveryFee, null)
  assert.equal(resolved.error, undefined)
})

test('a method the merchant has not enabled is ignored', () => {
  const config = { delivery: { enabled: false, zones: [] }, pickup: { enabled: true } }
  assert.equal(resolveService(config, { serviceMethod: 'delivery' }).serviceMethod, null)
  assert.equal(resolveService(config, { serviceMethod: 'pickup' }).serviceMethod, 'pickup')
})

test('an unknown method name is ignored', () => {
  for (const method of ['courier', '', null, 42, {}]) {
    assert.equal(resolveService(zoned, { serviceMethod: method }).serviceMethod, null)
  }
  assert.deepEqual(SERVICE_METHODS, ['delivery', 'dinein', 'pickup'])
})

test('delivery: a valid zone resolves to the merchant own fee', () => {
  const resolved = resolveService(zoned, {
    serviceMethod: 'delivery',
    deliveryZone: 'Karrada',
  })
  assert.equal(resolved.serviceMethod, 'delivery')
  assert.equal(resolved.deliveryZone, 'Karrada')
  assert.equal(resolved.deliveryFee, 3000)
  assert.equal(resolved.error, undefined)
})

test('delivery: the fee comes from the merchant, never from the request', () => {
  // A storefront is a public page; a submitted fee is attacker-controlled.
  const resolved = resolveService(zoned, {
    serviceMethod: 'delivery',
    deliveryZone: 'Center',
    deliveryFee: 0,
    fee: 0,
  })
  assert.equal(resolved.deliveryFee, 2000, 'the submitted fee must be ignored')
})

test('delivery: an unknown zone is refused, not silently made free', () => {
  // The regression this file exists for. It used to fall through to fee 0: the
  // order was accepted, the merchant's message showed no area, and the delivery
  // was free.
  const resolved = resolveService(zoned, {
    serviceMethod: 'delivery',
    deliveryZone: 'Nowhere',
  })
  assert.equal(resolved.error, 'ZONE_UNAVAILABLE')
  assert.equal(resolved.serviceMethod, null, 'a refused order carries no method')
  assert.notEqual(resolved.deliveryFee, 0, 'must not resolve to free delivery')
})

test('delivery: a missing zone is refused when zones are configured', () => {
  const resolved = resolveService(zoned, { serviceMethod: 'delivery' })
  assert.equal(resolved.error, 'ZONE_UNAVAILABLE')
})

test('delivery: a merchant with NO zones keeps working, fee-free', () => {
  // Flat, unpriced delivery is a legitimate setup that works today. The zone
  // check must not break it — this is why the guard is conditional on
  // zones.length rather than blanket.
  const flat = { delivery: { enabled: true, zones: [] } }
  const resolved = resolveService(flat, { serviceMethod: 'delivery' })
  assert.equal(resolved.error, undefined)
  assert.equal(resolved.serviceMethod, 'delivery')
  assert.equal(resolved.deliveryFee, 0)
})

test('delivery: zone names are matched after trimming', () => {
  const resolved = resolveService(zoned, {
    serviceMethod: 'delivery',
    deliveryZone: '  Center  ',
  })
  assert.equal(resolved.deliveryZone, 'Center')
  assert.equal(resolved.deliveryFee, 2000)
})

test('delivery: a negative or junk fee on the merchant zone floors at 0', () => {
  const odd = { delivery: { enabled: true, zones: [{ name: 'A', fee: -500 }, { name: 'B', fee: 'x' }] } }
  assert.equal(resolveService(odd, { serviceMethod: 'delivery', deliveryZone: 'A' }).deliveryFee, 0)
  assert.equal(resolveService(odd, { serviceMethod: 'delivery', deliveryZone: 'B' }).deliveryFee, 0)
})

test('dine-in carries a table number and never a fee', () => {
  const resolved = resolveService(zoned, { serviceMethod: 'dinein', tableNumber: ' 12 ' })
  assert.equal(resolved.serviceMethod, 'dinein')
  assert.equal(resolved.tableNumber, '12')
  assert.equal(resolved.deliveryFee, null)
})

test('pickup carries neither zone, fee nor table', () => {
  const resolved = resolveService(zoned, { serviceMethod: 'pickup', deliveryZone: 'Center' })
  assert.deepEqual(resolved, {
    serviceMethod: 'pickup',
    deliveryZone: null,
    deliveryFee: null,
    tableNumber: null,
  })
})

test('long free-text values are truncated before they reach the database', () => {
  const longZone = 'z'.repeat(300)
  const config = { delivery: { enabled: true, zones: [{ name: longZone, fee: 1000 }] } }
  const delivery = resolveService(config, { serviceMethod: 'delivery', deliveryZone: longZone })
  assert.equal(delivery.deliveryZone.length, 120, 'zone capped to the column width')

  const dinein = resolveService(zoned, { serviceMethod: 'dinein', tableNumber: 't'.repeat(50) })
  assert.equal(dinein.tableNumber.length, 20, 'table capped to the column width')
})
