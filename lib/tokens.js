const crypto = require('crypto');

// Same shape as invoices.js's generatePaymentToken()/PAYMENT_TOKEN_PATTERN (32 random
// bytes, base64url-encoded = 43 chars), factored out here so every new public-token
// surface (questionnaires) shares one implementation instead of copy-pasting it.
function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Bounded so an oversized value is rejected without ever reaching a regex/DB call, and
// non-string values are rejected by a typeof check before this even runs.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

function isValidTokenFormat(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

module.exports = { generateSecureToken, TOKEN_PATTERN, isValidTokenFormat };
