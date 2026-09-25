import assert from 'node:assert/strict'
import test from 'node:test'
import { isResolvableMapShortLink, parseMapCoordinates } from '../src/utils/mapLinks.js'

test('parseMapCoordinates: reads Google @lat,lng links', () => {
  assert.deepEqual(
    parseMapCoordinates('https://www.google.com/maps/place/Erbil/@36.1911,44.0092,17z'),
    { latitude: 36.1911, longitude: 44.0092 },
  )
})

test('parseMapCoordinates: reads Google data coordinates', () => {
  assert.deepEqual(
    parseMapCoordinates('https://www.google.com/maps/place/Test/data=!3d36.222!4d44.111'),
    { latitude: 36.222, longitude: 44.111 },
  )
})

test('parseMapCoordinates: reads query and OSM coordinates', () => {
  assert.deepEqual(
    parseMapCoordinates('https://maps.google.com/?q=36.2,44.1'),
    { latitude: 36.2, longitude: 44.1 },
  )
  assert.deepEqual(
    parseMapCoordinates('https://www.openstreetmap.org/#map=16/36.3/44.4'),
    { latitude: 36.3, longitude: 44.4 },
  )
})

test('parseMapCoordinates: rejects invalid coordinates', () => {
  assert.equal(parseMapCoordinates('https://maps.google.com/?q=136.2,244.1'), null)
  assert.equal(parseMapCoordinates('not a url'), null)
})

test('isResolvableMapShortLink: recognises Google short links only', () => {
  assert.equal(isResolvableMapShortLink('https://maps.app.goo.gl/RJBHxtJ8nYQo6sj56'), true)
  assert.equal(isResolvableMapShortLink('https://example.com/maps.app.goo.gl/RJB'), false)
})
