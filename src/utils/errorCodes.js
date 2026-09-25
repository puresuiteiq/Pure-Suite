/**
 * Stable, machine-readable error codes.
 *
 * Every controller returns `{ status: 'error', error: <English string> }`, and
 * the frontend renders that string verbatim — so an Arabic or Kurdish merchant
 * gets an English error in an otherwise fully translated app. A code alongside
 * the message lets the client translate what it recognises and fall back to the
 * server's text for anything it does not.
 *
 * Codes are added only where a caller actually branches or needs a translation.
 * Retrofitting all ~60 error sites would be churn for no gain.
 *
 * They live in one enumerable object on purpose: a test walks ERROR_CODES and
 * asserts every value has an `errors.<CODE>` key in all three locales, so a new
 * code cannot ship without its translations.
 */
export const ERROR_CODES = {
  // --- Credentials and accounts -------------------------------------------
  /** Wrong email or password. Deliberately identical for both. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** The supplied current password did not match. */
  CURRENT_PASSWORD_WRONG: 'CURRENT_PASSWORD_WRONG',
  /** New password shorter than the minimum. */
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  /** The account exists but has been suspended by the platform. */
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',

  // --- Storefront, seen by customers ---------------------------------------
  /** The slug or id in the URL matches no merchant. */
  MERCHANT_NOT_FOUND: 'MERCHANT_NOT_FOUND',
  /** The merchant is suspended by the platform. */
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  /** The merchant has turned the rating system off. */
  REVIEWS_DISABLED: 'REVIEWS_DISABLED',
  /** A review was submitted without a name. */
  REVIEW_NAME_REQUIRED: 'REVIEW_NAME_REQUIRED',
  /** A review rating outside 1-5. */
  REVIEW_RATING_INVALID: 'REVIEW_RATING_INVALID',
  /** Checkout with an empty basket. */
  ORDER_EMPTY: 'ORDER_EMPTY',
  /** None of the ordered products still exist. */
  ORDER_ITEMS_UNAVAILABLE: 'ORDER_ITEMS_UNAVAILABLE',
  /** The chosen size/option no longer exists on the product. */
  OPTION_UNAVAILABLE: 'OPTION_UNAVAILABLE',
  /** The basket priced out at zero or less. */
  ORDER_TOTAL_INVALID: 'ORDER_TOTAL_INVALID',

  // --- Storefront ordering -------------------------------------------------
  /** Ordered more of an item than the merchant has in stock. */
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  /** The item is marked unavailable or sold out. */
  ITEM_UNAVAILABLE: 'ITEM_UNAVAILABLE',
  /** The chosen delivery zone is not one the merchant offers. */
  ZONE_UNAVAILABLE: 'ZONE_UNAVAILABLE',
  /** The merchant has closed for the day. */
  STORE_CLOSED: 'STORE_CLOSED',

  // --- Storefront banners (merchant panel) ---------------------------------
  /** This database has no merchant_banners table (db:add-banners not applied). */
  BANNERS_UNAVAILABLE: 'BANNERS_UNAVAILABLE',
  /** Adding a banner past the per-merchant limit. Carries { max }. */
  BANNER_LIMIT_REACHED: 'BANNER_LIMIT_REACHED',
  /** A banner saved without an image, or with something that isn't one. */
  BANNER_IMAGE_REQUIRED: 'BANNER_IMAGE_REQUIRED',
  /** A banner link to a product or category that isn't in this merchant's menu. */
  BANNER_LINK_INVALID: 'BANNER_LINK_INVALID',
  /** The banner (or, for a reorder, one of them) no longer exists. */
  BANNER_NOT_FOUND: 'BANNER_NOT_FOUND',

  // --- Storefront welcome screen (merchant panel) --------------------------
  /** This database has no merchant_splash_media table (db:add-splash not applied). */
  SPLASH_UNAVAILABLE: 'SPLASH_UNAVAILABLE',
  /** The upload is not a picture or video the storefront can show. */
  SPLASH_MEDIA_INVALID: 'SPLASH_MEDIA_INVALID',
  /** The upload is over the limit for its kind. Carries { max } in MB. */
  SPLASH_MEDIA_TOO_LARGE: 'SPLASH_MEDIA_TOO_LARGE',

  // --- Admin operations ----------------------------------------------------
  /** A plan cannot be deleted while merchants are still assigned to it. */
  PLAN_IN_USE: 'PLAN_IN_USE',

  // --- Request problems ----------------------------------------------------
  /** Upload above the body-size limit — in practice always an image. */
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
}

/**
 * Build the standard error envelope.
 *
 * `code` is optional so this can be adopted incrementally: an untagged error is
 * exactly what every controller already returns today.
 *
 * `params` carries the values the translated message interpolates — a product
 * name, a remaining stock count. Without them the client can only render a
 * static sentence, which for anything counted means losing correct pluralisation
 * in Arabic, where six plural forms are in play rather than two.
 */
export function errorBody(message, code, params) {
  const body = { status: 'error', error: message }
  if (code) body.code = code
  if (params && Object.keys(params).length) body.params = params
  return body
}
