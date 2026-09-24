/**
 * The app's public base URL — the domain customers are given, which is not
 * necessarily the host that served a given request. A deployment can answer on
 * several hostnames at once (a platform-generated one, a preview environment, a
 * `www.` alias), and a link built from whichever one the admin happened to open
 * is wrong the moment it leaves the browser: a password-reset email or a
 * printed QR code has to carry the domain the business owns.
 *
 * APP_URL → the first CORS_ORIGIN → the dev server, so a local checkout with
 * no .env still resolves to something usable.
 */
export function appUrl() {
  const base =
    process.env.APP_URL ||
    (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0].trim()
  return base.replace(/\/+$/, '')
}
