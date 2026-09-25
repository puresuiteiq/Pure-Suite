import 'dotenv/config'
import app from './app.js'
import { ensureSchema } from './db/ensureSchema.js'
import { startSubscriptionExpirySweep } from './services/subscriptions.js'

const PORT = Number(process.env.PORT) || 4000

// Bring the schema up to date before the first request can hit a table that is
// missing a column. Never throws — a database that can't be reached at boot is
// logged and the server starts regardless (see ensureSchema).
await ensureSchema()
startSubscriptionExpirySweep()

// Explicit 0.0.0.0 (not just the default unspecified host): on some
// container platforms — Railway included — a bare `app.listen(PORT)` binds
// in a way their edge proxy can't reach, surfacing as an immediate 502 with
// no error in the app's own logs (the process is fine; nothing was ever
// listening where the proxy could reach it).
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Restaurant SaaS API listening on http://0.0.0.0:${PORT}`)
  console.log(`Health check: http://0.0.0.0:${PORT}/api/health`)
})
