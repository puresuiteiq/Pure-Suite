import 'dotenv/config'

/**
 * Auth configuration, sourced from the environment (.env in dev; real secrets
 * in production). The JWT signing secret is treated as required in production:
 * booting with a missing or well-known dev secret would let anyone forge admin
 * tokens, so we refuse to start instead.
 */
const isProd = process.env.NODE_ENV === 'production'
const DEV_FALLBACK_SECRET = 'dev-secret-change-me-in-production'

const secret = process.env.JWT_SECRET

if (isProd && (!secret || secret === DEV_FALLBACK_SECRET || secret.length < 32)) {
  throw new Error(
    'JWT_SECRET must be set to a strong, unique value (>= 32 chars) in production. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
  )
}

if (!isProd && (!secret || secret === DEV_FALLBACK_SECRET)) {
  // eslint-disable-next-line no-console
  console.warn(
    '[auth] Using a weak development JWT secret. Set JWT_SECRET in .env before deploying.',
  )
}

export const JWT_SECRET = secret || DEV_FALLBACK_SECRET
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d'

/** Minimum password length, shared by reset and change-password. */
export const MIN_PASSWORD_LENGTH = 8
