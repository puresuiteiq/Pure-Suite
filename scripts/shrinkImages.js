import 'dotenv/config'
import pool from '../src/config/db.js'

/**
 * Downscale the images already stored in the database.
 *
 * Uploads are downscaled in the browser now, but everything saved before that
 * is still whatever came off a phone camera — commonly 3-8 MB per photo, stored
 * as base64 (which adds another third) and re-sent to every customer who opens
 * the storefront. New uploads being small does nothing for a menu that was
 * photographed last year.
 *
 * This rewrites them in place at the same targets the browser uses: 1600px on
 * the long edge for product photos, 512px for logos, at quality 90. Images
 * already at or under target are skipped, so re-running costs almost nothing
 * and is safe.
 *
 *   npm run db:shrink-images -- --dry-run   # report only, change nothing
 *   npm run db:shrink-images                # rewrite
 *
 * Needs sharp, which is a dev-only dependency because this is a one-off
 * maintenance task, not something the API does at runtime:
 *
 *   npm install sharp
 *
 * To run it against a hosted database, point DB_HOST/DB_USER/DB_PASSWORD/DB_NAME
 * at that database and run it from your machine.
 */
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')

/** Read `--name=value` from the command line. */
function readFlag(name) {
  const hit = argv.find((a) => a.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : null
}

/**
 * Matches the browser-side targets in saas_project/src/utils/image.js.
 *
 * 1600 covers the largest place a photo is shown — the detail sheet renders it
 * at full viewport width, so a 430px phone at 3x needs roughly 1290 real
 * pixels. Quality 90 is visually indistinguishable from the original for
 * photography; the point of this script is to stop shipping 4000px originals,
 * not to compress what is left.
 *
 * Override per run:
 *   npm run db:shrink-images -- --max=2048 --quality=95
 */
const MAX_DIMENSION = {
  logo: Number(readFlag('--logo-max')) || 512,
  gallery: Number(readFlag('--max')) || 1600,
}
const QUALITY = Number(readFlag('--quality')) || 90

const kb = (n) => `${Math.round(n / 1024)} KB`

/** sharp is optional: fail with instructions rather than a module-not-found. */
async function loadSharp() {
  try {
    return (await import('sharp')).default
  } catch {
    console.error(
      'This script needs sharp, which is not installed.\n' +
        '  cd backend && npm install sharp\n' +
        'It is a dev-only dependency — the API never uses it at runtime.',
    )
    process.exitCode = 1
    return null
  }
}

/**
 * Shrink one data URL. Returns the original when there is nothing to gain —
 * already small enough, not a data URL, an SVG, or a re-encode that came out
 * bigger (already-optimised images do that).
 */
async function shrink(sharp, value, maxDim) {
  if (typeof value !== 'string' || !value.startsWith('data:image/')) return value
  // Vector art is already tiny and rasterising it would be a downgrade.
  if (value.startsWith('data:image/svg+xml')) return value

  const comma = value.indexOf(',')
  if (comma === -1) return value
  const input = Buffer.from(value.slice(comma + 1), 'base64')

  let meta
  try {
    meta = await sharp(input).metadata()
  } catch {
    return value // not decodable — leave it exactly as it is
  }
  if (!meta.width || !meta.height) return value
  if (Math.max(meta.width, meta.height) <= maxDim) return value

  // An image with transparency must not become JPEG: that paints the alpha
  // black, which would blacken every logo it touches.
  const hasAlpha = Boolean(meta.hasAlpha)
  const pipeline = sharp(input).resize({
    width: maxDim,
    height: maxDim,
    fit: 'inside',
    withoutEnlargement: true,
  })

  const out = hasAlpha
    ? await pipeline.webp({ quality: QUALITY }).toBuffer()
    : await pipeline.jpeg({ quality: QUALITY, mozjpeg: true }).toBuffer()

  if (out.length >= input.length) return value // no gain; keep the original

  const mime = hasAlpha ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${out.toString('base64')}`
}

const stats = { scanned: 0, rewritten: 0, before: 0, after: 0 }

function record(before, after) {
  stats.scanned += 1
  stats.before += before
  if (after !== null && after !== undefined) {
    stats.after += after
    if (after < before) stats.rewritten += 1
  } else {
    stats.after += before
  }
}

async function shrinkColumn(sharp, conn, { table, idColumn, column, maxDim, label }) {
  const [rows] = await conn.query(
    `SELECT \`${idColumn}\` AS id, \`${column}\` AS value FROM \`${table}\`
     WHERE \`${column}\` IS NOT NULL AND \`${column}\` LIKE 'data:image/%'`,
  )
  if (!rows.length) {
    console.log(`  ${label}: nothing stored`)
    return
  }

  let changed = 0
  for (const row of rows) {
    const before = row.value.length
    const next = await shrink(sharp, row.value, maxDim)
    record(before, next.length)
    if (next !== row.value) {
      changed += 1
      if (!dryRun) {
        await conn.query(`UPDATE \`${table}\` SET \`${column}\` = ? WHERE \`${idColumn}\` = ?`, [
          next,
          row.id,
        ])
      }
    }
  }
  console.log(`  ${label}: ${changed}/${rows.length} shrunk`)
}

/** products.images is a JSON array, so each entry is handled individually. */
async function shrinkGalleries(sharp, conn) {
  const [rows] = await conn.query(
    'SELECT id, images FROM products WHERE images IS NOT NULL',
  )
  if (!rows.length) {
    console.log('  product galleries: nothing stored')
    return
  }

  let changed = 0
  for (const row of rows) {
    let gallery
    try {
      gallery = typeof row.images === 'string' ? JSON.parse(row.images) : row.images
    } catch {
      continue // unreadable JSON — leave the row alone
    }
    if (!Array.isArray(gallery) || !gallery.length) continue

    let touched = false
    const next = []
    for (const image of gallery) {
      const before = typeof image === 'string' ? image.length : 0
      const shrunk = await shrink(sharp, image, MAX_DIMENSION.gallery)
      if (before) record(before, typeof shrunk === 'string' ? shrunk.length : before)
      if (shrunk !== image) touched = true
      next.push(shrunk)
    }

    if (touched) {
      changed += 1
      if (!dryRun) {
        await conn.query('UPDATE products SET images = ? WHERE id = ?', [
          JSON.stringify(next),
          row.id,
        ])
      }
    }
  }
  console.log(`  product galleries: ${changed}/${rows.length} shrunk`)
}

async function main() {
  const sharp = await loadSharp()
  if (!sharp) return

  const conn = await pool.getConnection()
  try {
    console.log(
      dryRun
        ? 'Scanning stored images (dry run — nothing will be changed):'
        : 'Shrinking stored images:',
    )

    await shrinkColumn(sharp, conn, {
      table: 'merchants',
      idColumn: 'id',
      column: 'logo',
      maxDim: MAX_DIMENSION.logo,
      label: 'merchant logos',
    })
    await shrinkColumn(sharp, conn, {
      table: 'products',
      idColumn: 'id',
      column: 'image',
      maxDim: MAX_DIMENSION.gallery,
      label: 'product covers',
    })
    await shrinkGalleries(sharp, conn)

    // Added by a later migration; absent on an older database.
    const [brandCol] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'admins'
         AND column_name = 'public_brand_logo'`,
    )
    if (brandCol[0].n > 0) {
      await shrinkColumn(sharp, conn, {
        table: 'admins',
        idColumn: 'id',
        column: 'public_brand_logo',
        maxDim: MAX_DIMENSION.logo,
        label: 'platform brand logo',
      })
    }

    const saved = stats.before - stats.after
    console.log('')
    console.log(`  images scanned : ${stats.scanned}`)
    console.log(`  rewritten      : ${stats.rewritten}`)
    console.log(`  stored size    : ${kb(stats.before)} -> ${kb(stats.after)}`)
    console.log(
      `  saved          : ${kb(saved)}` +
        (stats.before ? ` (${Math.round((saved / stats.before) * 100)}%)` : ''),
    )
    if (dryRun) console.log('\nDry run — nothing was written. Re-run without --dry-run to apply.')
    else console.log('\nDone. Storefronts will serve the smaller images immediately.')
  } catch (err) {
    console.error('Shrinking images failed:', err.message)
    process.exitCode = 1
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
