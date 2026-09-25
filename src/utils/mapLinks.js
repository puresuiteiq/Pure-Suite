const COORD = '(-?\\d+(?:\\.\\d+)?)'
const COORD_PAIR_RE = new RegExp(`${COORD}\\s*,\\s*${COORD}`)

function cleanUrl(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 2048) return null
  try {
    const url = new URL(trimmed)
    return ['http:', 'https:'].includes(url.protocol) ? url : null
  } catch {
    return null
  }
}

function validCoordinates(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  )
}

function coordinates(latitude, longitude) {
  const lat = Number(latitude)
  const lng = Number(longitude)
  return validCoordinates(lat, lng) ? { latitude: lat, longitude: lng } : null
}

function fromPair(value) {
  if (!value) return null
  const match = String(value).match(COORD_PAIR_RE)
  return match ? coordinates(match[1], match[2]) : null
}

/**
 * Pull latitude/longitude out of common map links without calling a geocoder.
 *
 * Supported examples:
 * - Google: /@36.19,44.01,17z, ?q=36.19,44.01, !3d36.19!4d44.01
 * - Apple:  ?ll=36.19,44.01
 * - OSM:    #map=16/36.19/44.01, ?mlat=36.19&mlon=44.01
 */
export function parseMapCoordinates(raw) {
  const url = cleanUrl(raw)
  if (!url) return null

  for (const key of ['q', 'query', 'll', 'center', 'destination', 'daddr']) {
    const found = fromPair(url.searchParams.get(key))
    if (found) return found
  }

  const mlat = url.searchParams.get('mlat')
  const mlon = url.searchParams.get('mlon')
  if (mlat != null && mlon != null) {
    const found = coordinates(mlat, mlon)
    if (found) return found
  }

  const decoded = decodeURIComponent(url.href)
  const at = decoded.match(new RegExp(`@${COORD}\\s*,\\s*${COORD}`))
  if (at) {
    const found = coordinates(at[1], at[2])
    if (found) return found
  }

  const bang = decoded.match(new RegExp(`!3d${COORD}!4d${COORD}`))
  if (bang) {
    const found = coordinates(bang[1], bang[2])
    if (found) return found
  }

  const osm = decoded.match(new RegExp(`#map=\\d+(?:\\.\\d+)?/${COORD}/${COORD}`))
  if (osm) {
    const found = coordinates(osm[1], osm[2])
    if (found) return found
  }

  return fromPair(decoded)
}

export function isResolvableMapShortLink(raw) {
  const url = cleanUrl(raw)
  if (!url) return false
  const host = url.hostname.toLowerCase()
  return host === 'maps.app.goo.gl' || host === 'goo.gl' || host.endsWith('.goo.gl')
}

export async function expandShortMapLink(raw, { timeoutMs = 5000 } = {}) {
  const url = cleanUrl(raw)
  if (!url || !isResolvableMapShortLink(url.href)) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url.href, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    })
    return response.url || null
  } finally {
    clearTimeout(timeout)
  }
}
