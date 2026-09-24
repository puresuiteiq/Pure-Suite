# RestoSaaS — Backend

Express + MySQL (mysql2) API for the multi-tenant restaurant/retail SaaS.

## Prerequisites

- Node.js 20+ (the repo is developed on 24; `node --test` is used for tests)
- MySQL 8 **or** MariaDB 10.4+

  The schema uses JSON columns and `CHECK` constraints. MariaDB stores `JSON` as
  `LONGTEXT`, which the mappers already handle — every JSON column is parsed
  defensively because mysql2 hands them back as strings either way.

## Quick start

```bash
cd backend
npm install
cp .env.example .env          # then set DB credentials + JWT_SECRET
npm run db:bootstrap -- --demo
npm run dev
```

`db:bootstrap` applies the schema and seeds the Super Admin, the three
subscription plans and the service-status board, then **prints a generated admin
password once**. Copy it — nothing stores the plaintext. `--demo` also loads
`db/seed.sql` (one restaurant with a menu and reviews).

Verify:

```bash
curl http://localhost:4000/api/health
```

`200` with `"database": "connected"` when the DB is reachable, `503` otherwise.

Then sign in at the frontend's `/login` with the printed credentials, and change
the password from the user menu.

## Environment

| Var | Default | Notes |
|-----|---------|-------|
| `NODE_ENV` | `development` | `production` enforces a strong `JWT_SECRET` and disables demo passwords |
| `PORT` | `4000` | API port |
| `DB_HOST` / `DB_PORT` | `localhost` / `3306` | |
| `DB_USER` / `DB_PASSWORD` | `root` / _(empty)_ | Use a dedicated user in production |
| `DB_NAME` | `restaurant_saas` | |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated allowed origins |
| `APP_URL` | first `CORS_ORIGIN` | The domain customers are given. Password-reset links are built from it, and the dashboard reads it from `GET /api/public/config` so QR codes carry the owned domain rather than whichever hostname served the dashboard |
| `JWT_SECRET` | _(required in prod)_ | ≥ 32 chars. The app refuses to start in production without one |
| `JWT_EXPIRES_IN` | `7d` | |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | _(unset)_ | With no `SMTP_HOST` the password-reset link is logged to the console instead of sent — fine locally, warned about loudly in production |
| `RATE_LIMIT_AUTH_WINDOW_MIN` / `RATE_LIMIT_AUTH_MAX` | `15` / `10` | Failed sign-ins only; successful ones never count |
| `RATE_LIMIT_PUBLIC_WINDOW_MIN` / `RATE_LIMIT_PUBLIC_MAX` | `10` / `40` | Storefront review/order writes. `GET` is never throttled |
| `TRUST_PROXY` | `1` in prod, `0` otherwise | Reverse-proxy hops. **Getting this wrong makes every request look like it comes from the proxy, so one bad actor rate-limits the whole platform** |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_NAME` / `SEED_ADMIN_PASSWORD` | `admin@restosaas.com` / `Platform Admin` / _(generated)_ | Used by `db:bootstrap`. There is no default password |

## Database

13 tables: `merchants`, `categories`, `products`, `merchant_banners`, `reviews`,
`orders`, `order_items`, `service_status`, `plans`, `admins`,
`admin_notification_states`, `merchant_notification_states`, `password_resets`.
A 14th, `applied_migrations`, is created by the migration scripts to record
themselves.

### Applied at boot

`src/db/ensureSchema.js` runs two steps on every start, each independently:

- `merchants.slug` — added if missing, given a unique index, and backfilled.
- `merchant_banners` + `merchants.show_banner` — created if missing, for the
  merchant panel's Banners page.

Both are idempotent, log under `[schema]`, and never block startup — an
unreachable database or a failed step is logged and the API starts anyway.
Banner reads check for the table first, so a storefront on a database without
it simply falls back to the carousel built from product photos.

It exists because a hosted deploy has no step where anyone runs the scripts
below, and the failure was silent: with no `slug` column every write touching it
was skipped, so saving a Storefront Link returned 200 and stored nothing.

### Migrating an existing database

`db/schema.sql` is current, so **a fresh `db:bootstrap` needs no migrations**.
They matter only for a database created by an older schema: it will read fine
and **fail on writes** touching a column it does not have. Those failures now
return an explanatory error naming the script to run rather than
"Internal server error".

There are 38 `db:*` scripts. Each is idempotent and records itself in
`applied_migrations`, so re-running is safe. The ones that change existing
columns matter most:

| Script | Fixes |
|--------|-------|
| `npm run db:widen-plan` | `merchants.plan` was an ENUM. Until it is a VARCHAR, **assigning any admin-designed plan fails** |
| `npm run db:widen-business-type` | Widens `merchants.business_type` to VARCHAR(60) for custom categories |
| `npm run db:fix-charset` | Converts the database + tables to `utf8mb4`. Needed on a server defaulting to latin1, where **Arabic text cannot be stored at all** |
| `npm run db:setup-auth` | Adds `merchants.password_hash` on a pre-auth database |
| `npm run db:add-slug` | Adds `merchants.slug` and backfills it, so storefronts are reachable at `/r/mamo` instead of `/r/7`. Old numeric links keep working. Also done at boot |
| `npm run db:add-banners` | Adds the `merchant_banners` table and `merchants.show_banner`. Until they exist the merchant Banners page cannot save, and every storefront shows the automatic product-photo carousel. Also done at boot |

Restart the API afterwards: column shapes are cached per process.

## Performance

The storefront is the request every customer waits on, so it is the one tuned:

- **Menu listings send cover images only.** Galleries were the bulk of the
  payload and none of it renders until a product is opened; they now come from
  `GET /api/public/merchants/:id/products/:pid/images` on demand. Measured on a
  five-item menu with photos: 2152 KB to 540 KB.
- **Responses are compressed.** Base64 encodes six bits per byte, so a quarter
  of an image-heavy response is redundancy the encoding introduced.
- **Storefront reads send `Cache-Control: private, no-cache`**, so an unchanged
  menu costs a 304 with no body rather than a refetch.
- **Fingerprinted assets are cached for a year**; `index.html` never is.

Two maintenance scripts, both idempotent:

| Script | What it does |
|--------|--------------|
| `npm run db:shrink-images` | Downscales images **already stored** — browser-side downscaling only applies to new uploads, so an existing deploy needs this once. Supports `--dry-run`. Needs `npm install sharp` (dev-only). |
| `npm run db:add-list-indexes` | Composite indexes for the three queries every storefront visit runs |

If a hosted storefront is still slow after all of this, check two things the
code cannot: that the database is in the **same region** as the app (every query
pays that round trip), and whether the service is **sleeping** between requests
(a cold Node start adds seconds to the first one).

## Tests

```bash
npm test        # node --test, no extra dependencies
```

Covers the pure modules — `utils/slug.js`, `utils/mappers.js`,
`utils/dbErrors.js`, `utils/service.js`, `utils/menuNormalize.js`,
`utils/banners.js`, `utils/imageResponse.js` and `middleware/language.js`. Controllers are excluded deliberately: they cache
schema probes in module scope with no reset hook, so testing them would make
failures order-dependent.

One test, `securityHeaders.test.js`, loads `app.js` itself to check the security
headers — they exist only on the Express app, so Vite's dev server can never
show a regression in them. It needs no database. It exists because Helmet's
default `Referrer-Policy: no-referrer` once made OpenStreetMap block every tile
of the merchant location map in production.

## Auth

Two httpOnly cookies (`merchant_token`, `admin_token`) so one browser can hold
both sessions — that is what lets a Super Admin impersonate a merchant and exit
back. CSRF uses the double-submit pattern: `GET /api/csrf-token` sets a readable
cookie that must be echoed in `X-CSRF-Token` on every mutating request.

Both roles can change their own password from the UI.
**Known limitation:** doing so does not invalidate sessions already signed in on
other devices. That needs a `token_version` column checked on every request;
`requireAdmin` currently makes no database call at all.

## Layout

```
backend/
├── db/
│   ├── schema.sql      # 13 tables
│   └── seed.sql        # optional demo data (IQD)
├── scripts/            # db:* migrations + seedBootstrap.js
├── test/               # node --test suites
└── src/
    ├── config/         # db pool, auth secrets, appUrl
    ├── controllers/    # one per resource area
    ├── db/ensureSchema.js
    ├── middleware/     # auth, csrf, language, rateLimit
    ├── routes/         # thin routers, mounted in app.js
    ├── utils/          # mappers, slug, service, menuNormalize, dbErrors, errorCodes, cookies, mailer
    ├── app.js          # express app (middleware + route mounting)
    └── server.js       # entry point
```

Note on route mounting: `/api/admin` is mounted **twice** in `app.js` — the
unauthenticated login router first, then the admin-gated profile router. Any
path the first one defines wins, so a new authenticated admin route must go on
`adminProfileRouter`.

## Currency

IQD only. Every stored money value is whole dinars and nothing is converted at
display time. `db/seed.sql` ships dinar prices directly, and `db:bootstrap`
records `convert-prices-to-iqd` as applied so the historical USD→IQD migration
can never multiply them by 1300 a second time.
