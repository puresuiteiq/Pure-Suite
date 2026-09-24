import nodemailer from 'nodemailer'
import { appUrl } from '../config/appUrl.js'

/**
 * Outbound email.
 *
 * The password-reset flow was fully implemented on both sides — hashed
 * single-use tokens, one-hour expiry, a generic response that never reveals
 * whether an address has an account — and then only ever logged the link to the
 * server console. A merchant who forgot their password had no way back in.
 *
 * Configure SMTP_HOST (plus SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM) and
 * mail is sent for real. With no SMTP_HOST the link is logged instead, which is
 * what makes local development work without an email account; in production
 * that fallback warns loudly, because it means resets silently are not arriving.
 */
const isProd = process.env.NODE_ENV === 'production'

let cachedTransport

/** The configured transport, or null when no SMTP host is set. */
function transport() {
  if (cachedTransport !== undefined) return cachedTransport

  const host = process.env.SMTP_HOST
  if (!host) {
    cachedTransport = null
    return cachedTransport
  }

  const port = Number(process.env.SMTP_PORT) || 587
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS

  cachedTransport = nodemailer.createTransport({
    host,
    port,
    // 465 is implicit TLS; 587 and 25 start plaintext and upgrade via STARTTLS.
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  })
  return cachedTransport
}

/** The From header. Falls back to a no-reply at the app's own domain. */
function fromAddress() {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM
  const host = appUrl().replace(/^https?:\/\//, '').replace(/[:/].*$/, '')
  return `RestoSaaS <no-reply@${host || 'localhost'}>`
}

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function resetTemplate(resetUrl) {
  const safeUrl = escapeHtml(resetUrl)
  return {
    subject: 'Reset your password',
    text: [
      'You asked to reset your password.',
      '',
      'Open this link to choose a new one. It expires in one hour and can be',
      'used once:',
      resetUrl,
      '',
      "If you didn't request this, you can ignore this email — your password",
      'has not changed.',
    ].join('\n'),
    html: [
      '<p>You asked to reset your password.</p>',
      `<p><a href="${safeUrl}">Choose a new password</a></p>`,
      '<p>The link expires in one hour and can be used once.</p>',
      `<p style="color:#64748b;font-size:12px;word-break:break-all">${safeUrl}</p>`,
      "<p style=\"color:#64748b;font-size:12px\">If you didn't request this, you can ignore this email — your password has not changed.</p>",
    ].join('\n'),
  }
}

/**
 * Sends the password-reset email.
 *
 * Never throws: a mail outage must not turn into a 500 that tells the caller
 * whether the address exists, which would undo the deliberately generic
 * response in authController.forgotPassword. A failure is logged, and in
 * development the link is logged too so the flow stays testable.
 */
export async function sendPasswordResetEmail(email, resetUrl) {
  /* eslint-disable no-console */
  const mailer = transport()

  if (!mailer) {
    console.log(`\n[mailer] Password reset requested for ${email}`)
    console.log(`[mailer] Reset link (valid 1 hour): ${resetUrl}\n`)
    if (isProd) {
      console.warn(
        '[mailer] SMTP_HOST is not set — the link was logged, not sent. ' +
          'Password resets are not reaching anyone. Configure SMTP_HOST / ' +
          'SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM.',
      )
    }
    return
  }

  const { subject, text, html } = resetTemplate(resetUrl)
  try {
    await mailer.sendMail({ from: fromAddress(), to: email, subject, text, html })
    console.log(`[mailer] Password reset email sent to ${email}`)
  } catch (err) {
    console.error(`[mailer] Could not send the reset email to ${email}: ${err.message}`)
    if (!isProd) {
      console.log(`[mailer] Reset link (valid 1 hour): ${resetUrl}`)
    }
  }
  /* eslint-enable no-console */
}
