/**
 * The platform's own identity, for what it says about itself outside the app:
 * link-preview cards and the "Designed by" credit on storefront welcome screens.
 *
 * Deliberately not the Super Admin's footer texts (public_brand_name /
 * public_powered_by_text): those are laid out as a footer and get used
 * creatively — "POWERED BY" in the name field reads right in the footer and
 * wrong everywhere else.
 */
export function platformName() {
  return (process.env.PLATFORM_NAME || 'Pure Suite').trim()
}

export function platformDescription() {
  return (
    process.env.PLATFORM_DESCRIPTION ||
    'منصّة لإنشاء قوائم الطعام والمتاجر الإلكترونية، واستقبال الطلبات مباشرة عبر واتساب.'
  ).trim()
}

/**
 * Where this API is reachable from the internet, for absolute image links in
 * share cards (a crawler cannot follow a relative one). PUBLIC_API_URL when the
 * pages are served from a different hostname than the API
 * (puresuiteiq.com vs api.puresuiteiq.com); otherwise the request's own origin.
 */
export function publicApiOrigin(req) {
  const configured = String(process.env.PUBLIC_API_URL || '').trim()
  const origin = configured || `${req.protocol}://${req.get('host')}`
  return origin.replace(/\/+$/, '').replace(/\/api$/, '')
}
