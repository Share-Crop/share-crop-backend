/**
 * Stripe Checkout success/cancel URLs must not be attacker-controlled open redirects.
 * Origins are derived from env (CORS / explicit frontend URLs) plus safe local dev defaults.
 */

function tryOriginFromEnv(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

/**
 * @returns {string[]} list of allowed origins (e.g. https://app.example.com)
 */
function getAllowedCheckoutOrigins() {
  const origins = new Set();

  const cors = process.env.CORS_ORIGIN || '';
  for (const part of cors.split(',')) {
    const o = tryOriginFromEnv(part);
    if (o) origins.add(o);
  }

  for (const key of [
    'FRONTEND_URL',
    'SUCCESS_URL',
    'CANCEL_URL',
    'STRIPE_SUCCESS_URL',
    'STRIPE_CANCEL_URL',
  ]) {
    const o = tryOriginFromEnv(process.env[key]);
    if (o) origins.add(o);
  }

  const extra = process.env.CHECKOUT_ALLOWED_ORIGINS || '';
  for (const part of extra.split(',')) {
    const o = tryOriginFromEnv(part);
    if (o) origins.add(o);
  }

  if (process.env.NODE_ENV !== 'production') {
    ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'].forEach(
      (u) => origins.add(u)
    );
  }

  return [...origins];
}

function isLocalDevOrigin(origin) {
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * @param {string} rawUrl - full URL for success or cancel redirect
 * @param {string[]} allowedOrigins - from getAllowedCheckoutOrigins()
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
function validateCheckoutRedirectUrl(rawUrl, allowedOrigins) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, reason: 'missing_url' };
  }
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_protocol' };
  }
  if (!allowedOrigins.includes(u.origin)) {
    return { ok: false, reason: 'origin_not_allowed' };
  }
  if (u.protocol === 'http:' && !isLocalDevOrigin(u.origin)) {
    return { ok: false, reason: 'http_only_allowed_on_localhost' };
  }
  if (u.protocol === 'https:' && isLocalDevOrigin(u.origin)) {
    // allow https localhost for tooling
  }
  return { ok: true, url: u };
}

/**
 * Resolves and validates success + cancel URLs for Checkout.
 * @param {string|undefined} successUrl - from client (optional)
 * @param {string|undefined} cancelUrl - from client (optional)
 * @returns {{ success: string, cancel: string }}
 */
function resolveValidatedCheckoutUrls(successUrl, cancelUrl) {
  const allowed = getAllowedCheckoutOrigins();
  if (allowed.length === 0) {
    throw new Error(
      'No allowed checkout origins: set CORS_ORIGIN and/or FRONTEND_URL (or CHECKOUT_ALLOWED_ORIGINS) so success/cancel URLs can be validated'
    );
  }

  const fallbackSuccess =
    process.env.STRIPE_SUCCESS_URL ||
    process.env.SUCCESS_URL ||
    (allowed[0] ? `${allowed[0]}/farmer/buy-coins` : null);
  const fallbackCancel =
    process.env.STRIPE_CANCEL_URL ||
    process.env.CANCEL_URL ||
    (allowed[0] ? `${allowed[0]}/farmer/buy-coins` : null);

  const rawSuccess = successUrl || fallbackSuccess;
  const rawCancel = cancelUrl || fallbackCancel;

  const vs = validateCheckoutRedirectUrl(rawSuccess, allowed);
  if (!vs.ok) {
    throw new Error(`Invalid success_url (${vs.reason})`);
  }
  const vc = validateCheckoutRedirectUrl(rawCancel, allowed);
  if (!vc.ok) {
    throw new Error(`Invalid cancel_url (${vc.reason})`);
  }

  return { success: rawSuccess, cancel: rawCancel };
}

module.exports = {
  getAllowedCheckoutOrigins,
  validateCheckoutRedirectUrl,
  resolveValidatedCheckoutUrls,
};
