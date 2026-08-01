// Resolves the public origin used to build absolute links (questionnaire respond
// links, admin deep-links inside emails). Centralized here because getting this wrong
// has two distinct failure modes seen in this app before: a Preview deployment (or
// local `vercel dev`) silently generating a link that points at the live production
// domain, and SITE_URL producing a double slash when it already ends in one.

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// Priority order:
//  1. SITE_URL, but only on the real Production deployment -- otherwise a Preview
//     deployment (which typically inherits the same env vars) would generate links
//     back to the production domain instead of its own preview URL.
//  2. VERCEL_URL, the unique per-deployment hostname Vercel injects for Preview
//     deployments (and Production, though SITE_URL should be authoritative there).
//  3. The incoming request's own Host header -- covers `vercel dev` locally, where
//     neither of the above is set.
//  4. SITE_URL (even off-Production) or the production domain, as a last resort for
//     code paths with no request object available.
function resolveSiteBase(req) {
  if (process.env.SITE_URL && process.env.VERCEL_ENV === 'production') {
    return normalizeBase(process.env.SITE_URL);
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  const host = req?.headers?.host;
  if (host) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const isLocalHost = host.startsWith('localhost') || host.startsWith('127.0.0.1');
    const proto = forwardedProto || (isLocalHost ? 'http' : 'https');
    return `${proto}://${host}`;
  }
  return normalizeBase(process.env.SITE_URL) || 'https://perlertechnologies.com';
}

function questionnaireLink(token, req) {
  if (!token) return null;
  return `${resolveSiteBase(req)}/questionnaire/${encodeURIComponent(token)}`;
}

module.exports = { resolveSiteBase, normalizeBase, questionnaireLink };
