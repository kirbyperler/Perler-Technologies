function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader('Allow', methods.join(', '));
  res.status(405).json({ error: `Method ${req.method} not allowed.` });
  return false;
}

function action(req) {
  return String(req.query?.action || '').trim().slice(0, 40).toLowerCase();
}

function escapeRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Vercel usually parses JSON bodies into req.body automatically, but this covers
// callers that send a raw string body (matches the pattern in api/inquiry.js).
function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch { return {}; }
  }
  return req.body || {};
}

module.exports = { allowMethods, action, escapeRegex, jsonBody };
