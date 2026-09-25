/**
 * Order service methods: how the customer wants the order fulfilled, and what
 * the delivery costs.
 *
 * Resolved entirely against the merchant's own stored configuration — the
 * client chooses a method and a zone by name, never a price. A fee sent by the
 * browser is ignored, because a storefront is a public page and anything it
 * submits is attacker-controlled.
 *
 * Extracted from publicController so it can be tested directly: it was a
 * module-private function inside a 200-line transaction, which is why the
 * free-delivery hole below went unnoticed.
 */
export const SERVICE_METHODS = ['delivery', 'dinein', 'pickup']

/** Nothing configured, or a method the merchant does not offer. */
const NO_SERVICE = {
  serviceMethod: null,
  deliveryZone: null,
  deliveryFee: null,
  tableNumber: null,
}

const deliveryAreaLabel = (zone, area) =>
  `${String(zone.name).trim()} / ${String(area.name).trim()}`.slice(0, 120)

/**
 * @param {object|null} config  merchant.service_methods, already parsed
 * @param {object} body         the submitted order
 * @returns {{ serviceMethod, deliveryZone, deliveryFee, tableNumber, error? }}
 *
 * `error` is set only when the request names a delivery zone the merchant does
 * not offer. Everything else degrades to a plain, fee-free order, matching the
 * behaviour of a merchant who has never configured service methods at all.
 */
export function resolveService(config, body) {
  const method = SERVICE_METHODS.includes(body?.serviceMethod) ? body.serviceMethod : null
  if (!config || !method || config[method]?.enabled !== true) {
    return { ...NO_SERVICE }
  }

  if (method === 'delivery') {
    const zones = Array.isArray(config.delivery?.zones) ? config.delivery.zones : []
    const wanted = body?.deliveryZone ? String(body.deliveryZone).trim() : ''
    const zone = zones.find((z) => z && String(z.name).trim() === wanted) ?? null
    const areaHit = zones.reduce((found, z) => {
      if (found) return found
      const areas = Array.isArray(z?.areas) ? z.areas : []
      const area = areas.find((a) => deliveryAreaLabel(z, a) === wanted)
      return area ? { zone: z, area } : null
    }, null)

    // A merchant who enables delivery without defining any zones is running
    // flat, unpriced delivery. That is a legitimate setup that works today, so
    // it must keep working — no zone, no fee, no error.
    if (zones.length === 0) {
      return {
        serviceMethod: 'delivery',
        deliveryZone: null,
        deliveryFee: 0,
        tableNumber: null,
      }
    }

    // Zones ARE defined, so the chosen one has to be among them. Previously an
    // unmatched or missing zone silently fell through to a zero fee: the order
    // was accepted, the merchant's WhatsApp message showed no area, and the
    // delivery was free. The storefront only ever submits names from the
    // merchant's own list, so reaching this means a crafted request.
    if (!zone && !areaHit) {
      return { ...NO_SERVICE, error: 'ZONE_UNAVAILABLE' }
    }

    if (areaHit) {
      return {
        serviceMethod: 'delivery',
        deliveryZone: deliveryAreaLabel(areaHit.zone, areaHit.area),
        deliveryFee: Math.max(0, Math.round(Number(areaHit.area.fee) || 0)),
        tableNumber: null,
      }
    }

    return {
      serviceMethod: 'delivery',
      deliveryZone: String(zone.name).trim().slice(0, 120),
      deliveryFee: Math.max(0, Math.round(Number(zone.fee) || 0)),
      tableNumber: null,
    }
  }

  if (method === 'dinein') {
    const table = body?.tableNumber ? String(body.tableNumber).trim().slice(0, 20) : null
    return {
      serviceMethod: 'dinein',
      deliveryZone: null,
      deliveryFee: null,
      tableNumber: table,
    }
  }

  return { serviceMethod: 'pickup', deliveryZone: null, deliveryFee: null, tableNumber: null }
}
