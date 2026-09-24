import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import healthRouter from './routes/health.js'
import authRouter from './routes/auth.js'
import adminAuthRouter from './routes/adminAuth.js'
import merchantRouter from './routes/merchant.js'
import publicRouter from './routes/public.js'
import merchantsRouter from './routes/merchants.js'
import overviewRouter from './routes/overview.js'
import servicesRouter from './routes/services.js'
import plansRouter from './routes/plans.js'
import adminOrdersRouter from './routes/adminOrders.js'
import notificationsRouter from './routes/notifications.js'
import adminReviewsRouter from './routes/adminReviews.js'
import adminProfileRouter from './routes/adminProfile.js'
import { requireAdmin } from './middleware/auth.js'
import { detectLanguage } from './middleware/language.js'
import { issueCsrfToken, csrfProtection } from './middleware/csrf.js'
import { publicWriteLimiter, trustProxyHops } from './middleware/rateLimit.js'
import { describeDbError } from './utils/dbErrors.js'
import { ERROR_CODES, errorBody } from './utils/errorCodes.js'

const app = express()

// Rate limiting keys on the client IP, which is the proxy's unless Express is
// told how many hops to trust — see trustProxyHops for why this matters.
app.set('trust proxy', trustProxyHops())

// Baseline security headers: nosniff, frame-options, HSTS, referrer-policy,
// cross-origin isolation.
//
// The Content-Security-Policy is deliberately OFF. index.html carries an inline
// pre-paint script that reads the saved theme from localStorage, and blocking it
// reintroduces the light/dark flash it exists to prevent. Allowing it needs
// either a sha256 hash -- which breaks silently on any whitespace edit to a
// hand-maintained HTML file -- or a nonce, which needs per-request HTML
// rendering to replace express.static + sendFile below. A CSP also has to
// account for Google Fonts, OpenStreetMap tiles, and the data: URLs every logo
// and product image is stored as.
//
// Left as follow-up: ship Content-Security-Policy-Report-Only first to see what
// a real policy would break before enforcing one.
//
// The Referrer-Policy is set explicitly. Helmet's default, no-referrer, blanked
// the merchant location map on production: OpenStreetMap refuses tile requests
// that carry no Referer. strict-origin-when-cross-origin (the browser default)
// sends other sites only the origin, never the path or query -- which matters
// because the password-reset URL carries its token in the query, and every page
// loads Google Fonts. Never widen this to unsafe-url or no-referrer-when-downgrade.
app.use(
  helmet({
    contentSecurityPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
)

// Compress responses.
//
// Menu and merchant payloads are dominated by base64 image data, and base64 is
// exactly the case gzip handles well: it encodes 6 bits per byte, so a quarter
// of every response is redundancy the encoding itself introduced. Measured on a
// realistic storefront, this alone takes 2152 KB down to 1628 KB — and the
// saving is larger on the text-heavy admin endpoints.
//
// Placed before the routes so it wraps every JSON response and the built
// frontend served below.
app.use(compression())

// Allow the frontend dev server(s) listed in CORS_ORIGIN (comma-separated).
const origins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

// credentials:true so browsers include the httpOnly auth cookies.
app.use(cors({ origin: origins, credentials: true }))
app.use(cookieParser())
app.use(express.json({ limit: '10mb' })) // logos/images may arrive as data URLs
app.use(detectLanguage) // req.lang — resolves translated menu content

// Quick sanity/info route — under /api, not '/', so it doesn't shadow the
// frontend's index.html once that's served from this same process below.
app.get('/api', (req, res) => {
  res.json({ name: 'Restaurant SaaS API', version: '0.1.0' })
})

// CSRF: hand out a token (safe GET), then guard all mutating requests below.
app.get('/api/csrf-token', issueCsrfToken)
app.use(csrfProtection)

// API routes.
app.use('/api', healthRouter)
app.use('/api/auth', authRouter)
// NOTE: /api/admin is mounted twice — this unauthenticated login/logout router,
// and the admin-gated adminProfileRouter below. The rate limiter therefore lives
// on the individual credential routes inside these routers, not on the prefix:
// mounting it here would also count every /api/admin/appearance and
// /api/admin/reviews request against the sign-in budget.
app.use('/api/admin', adminAuthRouter)

// Authenticated — the current merchant's own resources (merchantId from token).
app.use('/api/merchant', merchantRouter)

// Public — unauthenticated storefront reads, plus review/order writes. The
// limiter skips GET, so browsing a menu is never throttled.
app.use('/api/public', publicWriteLimiter, publicRouter)

// Super Admin — require an admin-role token.
app.use('/api/merchants', requireAdmin, merchantsRouter)
app.use('/api/overview', requireAdmin, overviewRouter)
app.use('/api/services', requireAdmin, servicesRouter)
app.use('/api/plans', requireAdmin, plansRouter)
app.use('/api/orders', requireAdmin, adminOrdersRouter)
app.use('/api/notifications', requireAdmin, notificationsRouter)
app.use('/api/admin/reviews', requireAdmin, adminReviewsRouter)
app.use('/api/admin', requireAdmin, adminProfileRouter)

// Single-service deploys (Railway, or any host running just this one process)
// serve the built frontend from here too, so the whole app lives on one
// origin — required for the auth cookies (sameSite: 'lax') to work at all,
// since a separate frontend domain can't receive them. Skipped when there's
// no build present (plain `npm run dev`, or a split VPS+Nginx deploy where
// Nginx serves the frontend instead — see saas_project's own dist output).
const frontendDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../saas_project/dist')
if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
  // Vite fingerprints every asset filename, so a given URL's bytes can never
  // change — they can be cached for a year and a repeat visit downloads no
  // JavaScript, CSS or images at all. Without this Express sends no
  // Cache-Control and browsers revalidate on every navigation, which on a
  // high-latency mobile connection is most of the wait.
  //
  // index.html is the exception: it is the file that names the current hashes,
  // so caching it would pin visitors to a stale build.
  app.use(
    express.static(frontendDist, {
      maxAge: '1y',
      immutable: true,
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache')
        }
      },
    }),
  )
  // React Router client-side routes (e.g. /merchant, /r/:id) aren't real
  // files — fall back to index.html for any non-API GET so the SPA's own
  // router can take over. Placed after express.static (real files still win)
  // and before the JSON 404 below (which now only ever fires for /api/*).
  app.get(/^(?!\/api).*/, (req, res) => {
    // Always revalidated — see the static block above.
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(path.join(frontendDist, 'index.html'))
  })
}

// 404 fallback.
app.use((req, res) => {
  res.status(404).json({ status: 'error', error: 'Not found' })
})

// Centralized error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err)
  // A database that is merely missing a migration (or unreachable, or not
  // utf8mb4) is an operational problem the operator can fix — say which one,
  // instead of reporting every failure as an indistinguishable crash.
  const described = describeDbError(err)
  if (described) {
    return res.status(described.status).json({ status: 'error', error: described.error })
  }
  // body-parser rejections carry their own meaning and were being reported as
  // a crash: malformed JSON is the caller's mistake, and an oversized body is
  // almost always a logo/photo above the express.json limit set above.
  if (err?.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ status: 'error', error: 'The request body is not valid JSON.' })
  }
  if (err?.type === 'entity.too.large') {
    return res
      .status(413)
      .json(
        errorBody(
          'That upload is too large — images must stay under 10 MB.',
          ERROR_CODES.IMAGE_TOO_LARGE,
        ),
      )
  }
  // Nothing recognised: the detail stays in the server log, but naming the
  // error code keeps the response from being a dead end to report.
  const code = typeof err?.code === 'string' ? ` (${err.code})` : ''
  res.status(500).json({ status: 'error', error: `Internal server error${code}` })
})

export default app
