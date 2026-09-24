/**
 * Reads the caller's active UI language into `req.lang`, so mappers can resolve
 * translated menu content without every controller re-parsing the header.
 *
 * The frontend sends its exact i18next code (`en` | `ar` | `ku-badini`) in
 * Accept-Language. Anything unrecognised resolves to undefined, which makes the
 * mappers fall back to the merchant's original text — the same thing that
 * happens for a language with no translation filled in.
 */
import { SUPPORTED_LANGS } from '../utils/mappers.js'

const SUPPORTED = new Set(SUPPORTED_LANGS)

export function detectLanguage(req, res, next) {
  const header = req.get('accept-language') ?? ''
  // Take the first tag and drop any q-weight; browsers may send a full list,
  // our client sends a single code.
  const tag = header.split(',')[0].split(';')[0].trim()
  req.lang = SUPPORTED.has(tag) ? tag : undefined
  next()
}
