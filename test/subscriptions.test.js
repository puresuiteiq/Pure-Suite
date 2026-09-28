import test from 'node:test'
import assert from 'node:assert/strict'
import { subscriptionToday } from '../src/services/subscriptions.js'

test('subscriptionToday uses the platform time zone date, not UTC', () => {
  assert.equal(subscriptionToday(new Date('2026-09-27T21:30:00.000Z')), '2026-09-28')
})
