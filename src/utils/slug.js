/**
 * Storefront slugs — the human-readable part of a public menu URL
 * (`/r/mamo` instead of `/r/7`).
 *
 * A slug is deliberately Latin-only: `[a-z0-9-]`. A slug built from an Arabic
 * name would survive in the database but not in a URL — `/r/نكهة-بغداد` is
 * percent-encoded into unreadable bytes the moment it is copied, printed on a
 * QR code, or pasted into a chat. A name with no Latin characters therefore
 * falls back to the id-based `m<id>` form, and the Super Admin can type a
 * Latin slug over it at any time.
 *
 * A slug is never a bare number, so `/r/7` stays unambiguously a merchant id
 * and every QR code printed before slugs existed keeps working.
 */

export const SLUG_MAX = 80

/**
 * Build a URL-safe slug from a business name. Returns '' when the name has no
 * Latin characters at all ("نكهة بغداد", "!!!"), which callers turn into the
 * `m<id>` fallback below.
 */
export function slugify(value) {
  if (value == null) return ''
  let s = String(value)
    // Latin accents fold to ASCII (Café → cafe); everything else is dropped.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    // Separators become hyphens; anything outside [a-z0-9-] disappears.
    .replace(/[\s_./\\]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!s) return ''
  // A purely numeric slug would be indistinguishable from a merchant id in
  // /r/:param, so keep that space reserved for ids.
  if (/^\d+$/.test(s)) s = `m${s}`
  return s.slice(0, SLUG_MAX).replace(/-+$/g, '')
}

/** The slug for a merchant whose name yields nothing usable: m5, m12, … */
export function fallbackSlug(id) {
  return `m${id}`
}

/** `base` with the merchant id appended, kept inside SLUG_MAX. */
function withId(base, id) {
  const suffix = `-${id}`
  return `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, '')}${suffix}`
}

/**
 * The slug a merchant should hold, applied identically at create time and by
 * the boot backfill so the two can never disagree:
 *
 *   name-derived        Tech Zone   → tech-zone
 *   no Latin characters نكهة بغداد  → m5
 *   already taken       Tech Zone   → tech-zone-7
 *
 * The id-suffixed form always terminates because ids are unique — the loop
 * below only exists for the pathological case where an admin has manually
 * typed that exact slug onto another merchant.
 *
 * `isTaken(candidate, excludeId)` is injected rather than queried here, so the
 * caller keeps ownership of the SQL (and its connection/transaction).
 */
export async function slugForMerchant(name, id, isTaken) {
  const base = slugify(name)
  const candidates = base
    ? [base, withId(base, id), fallbackSlug(id)]
    : [fallbackSlug(id)]

  for (const candidate of candidates) {
    if (!(await isTaken(candidate, id))) return candidate
  }
  for (let n = 2; n < 1000; n += 1) {
    const candidate = withId(fallbackSlug(id), n)
    if (!(await isTaken(candidate, id))) return candidate
  }
  // Practically unreachable; keeps the caller from looping forever.
  return withId(fallbackSlug(id), Date.now().toString(36))
}

/**
 * Validate a slug the admin typed. Returns { value } or { error }.
 * Deliberately stricter than slugify: an admin-supplied slug is rejected rather
 * than silently rewritten, so what they typed is what they get — or a clear
 * message saying why not.
 */
export function validateSlug(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return { error: 'Storefront link cannot be empty' }
  if (s.length > SLUG_MAX) return { error: `Storefront link is too long (max ${SLUG_MAX} characters)` }
  if (/^\d+$/.test(s)) {
    return { error: 'Storefront link cannot be only numbers — that form is reserved for merchant ids' }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) {
    return {
      error:
        'Storefront link may use English letters, numbers and single hyphens only. ' +
        'Arabic is not usable here because a browser encodes it into unreadable ' +
        'characters in the address bar and on a printed QR code.',
    }
  }
  return { value: s }
}
