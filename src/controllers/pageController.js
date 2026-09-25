import fs from 'node:fs'
import crypto from 'node:crypto'
import pool from '../config/db.js'
import { appUrl } from '../config/appUrl.js'
import { platformDescription, platformName, publicApiOrigin } from '../config/platform.js'
import { imageVersion } from '../utils/imageResponse.js'
import { injectPageMeta, pageMetaTags, storefrontMeta } from '../utils/pageMeta.js'
import { resolveMerchant } from './publicController.js'

/**
 * The app's HTML pages, with link-preview tags filled in per URL.
 *
 * A storefront link (/r/:merchant) previews as that store — its name,
 * description and logo; every other page as the platform. Crawlers read only
 * this HTML, so it is the one place the card can come from.
 *
 * Any failure here (the database down, a store that doesn't exist) still sends
 * the page with the platform's card: a customer must never get an error page
 * because a preview couldn't be built.
 */

const STOREFRONT_PATH = /^\/r\/([^/?#]+)\/?$/

/** index.html, re-read only when a new build replaces it. */
function readIndex(indexPath) {
  const { mtimeMs } = fs.statSync(indexPath)
  if (readIndex.cache?.path !== indexPath || readIndex.cache.mtimeMs !== mtimeMs) {
    readIndex.cache = { path: indexPath, mtimeMs, html: fs.readFileSync(indexPath, 'utf8') }
  }
  return readIndex.cache.html
}

/** The Super Admin's platform logo as an image URL, versioned by its own bytes. */
async function brandLogoUrl(apiOrigin) {
  const [admins] = await pool.query('SELECT public_brand_logo FROM admins ORDER BY id ASC LIMIT 1')
  const logo = admins[0]?.public_brand_logo
  if (!logo) return null
  const v = crypto.createHash('sha1').update(logo).digest('hex').slice(0, 12)
  return `${apiOrigin}/api/public/brand-logo?v=${v}`
}

async function metaFor(req) {
  const apiOrigin = publicApiOrigin(req)
  const url = `${appUrl()}${req.path}`
  const siteName = platformName()
  const platform = {
    title: siteName,
    description: platformDescription(),
    url,
    siteName,
    image: null,
  }

  try {
    const brandLogo = await brandLogoUrl(apiOrigin)
    const match = STOREFRONT_PATH.exec(req.path)
    if (match) {
      const param = decodeURIComponent(match[1])
      const merchant = await resolveMerchant(param)
      if (merchant) {
        const logo = merchant.logo
          ? `${apiOrigin}/api/public/merchants/${encodeURIComponent(param)}/logo?v=${imageVersion(merchant.updated_at)}`
          : brandLogo
        return storefrontMeta(merchant, { siteName, url, image: logo })
      }
    }
    return { ...platform, image: brandLogo }
  } catch (err) {
    console.error('[page-meta] falling back to the platform card:', err?.message ?? err)
    return platform
  }
}

export function renderAppPage(indexPath) {
  return async (req, res, next) => {
    try {
      const html = injectPageMeta(readIndex(indexPath), pageMetaTags(await metaFor(req)))
      // Always revalidated: this is the file that names the current asset hashes.
      res.setHeader('Cache-Control', 'no-cache')
      res.type('html').send(html)
    } catch (err) {
      next(err)
    }
  }
}
