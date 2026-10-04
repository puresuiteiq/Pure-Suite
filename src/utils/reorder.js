/**
 * Reordering part of a list.
 *
 * The merchant's menu editor loads items in pages, so a drag can only ever
 * reorder the items it has — possibly the first 10 of a category of 40. The
 * order it sends therefore covers a subset. This places that subset, in its
 * new order, into the slots its members already occupy, and leaves every
 * other item where it was:
 *
 *   full:  [a, b, c, d, e]    moved: [c, a]   (a and c swapped)
 *   →      [c, b, a, d, e]
 *
 * The result is the complete new order, which the caller numbers 0..n-1 —
 * which also repairs a list whose stored positions had collided (old rows
 * all saved at 0).
 *
 * Returns { order } or { error } when `moved` isn't a set of ids in `full`
 * (unknown, duplicated, or empty) — a stale page, or someone else's ids.
 * Pure, so it is unit-tested.
 */
export function reorderWithin(full, moved) {
  const fullIds = full.map(Number)
  const movedIds = Array.isArray(moved) ? moved.map(Number) : []
  const known = new Set(fullIds)
  if (
    !movedIds.length ||
    new Set(movedIds).size !== movedIds.length ||
    !movedIds.every((id) => Number.isInteger(id) && known.has(id))
  ) {
    return { error: 'invalid' }
  }
  const movedSet = new Set(movedIds)
  let next = 0
  return { order: fullIds.map((id) => (movedSet.has(id) ? movedIds[next++] : id)) }
}

/** `UPDATE … SET position = CASE id …` for a complete order: SQL + values. */
export function positionCase(order) {
  return {
    sql: `CASE id ${order.map(() => 'WHEN ? THEN ?').join(' ')} END`,
    values: order.flatMap((id, index) => [id, index]),
  }
}
