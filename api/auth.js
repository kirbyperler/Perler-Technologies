const bcrypt = require('bcryptjs');
const { getDb } = require('../lib/db');
const { allowMethods, action, jsonBody } = require('../lib/http');
const { clean, isValidEmail } = require('../lib/validation');
const {
  signSession,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  requireAdmin,
  getLoginLock,
  recordLoginFailure,
  resetLoginAttempts
} = require('../lib/auth');

// A precomputed bcrypt hash with no matching password. Comparing against it when the
// email isn't found keeps login response times the same whether the account exists or
// not, so timing can't be used to enumerate admin emails.
const DUMMY_HASH = '$2b$12$SiAfsquO5iLuh7y5DHQsMePtthNVp0AJNP4U2WxTlIp0l/hWjcI/y';
const GENERIC_LOGIN_ERROR = 'Invalid email or password.';

async function login(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;

  const body = jsonBody(req);
  const email = clean(body.email, 200).toLowerCase();
  const password = String(body.password || '');
  if (!email || !password || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const db = await getDb();

  const lock = await getLoginLock(db, email);
  if (lock.locked) {
    res.setHeader('Retry-After', String(lock.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
  }

  const admin = await db.collection('admins').findOne({ email });
  const valid = await bcrypt.compare(password, admin?.passwordHash || DUMMY_HASH).catch(() => false);

  if (!admin || !valid) {
    await recordLoginFailure(db, email);
    return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
  }

  await resetLoginAttempts(db, email);
  const token = signSession({ adminId: String(admin._id), role: 'Admin' });
  setSessionCookie(res, token);
  return res.status(200).json({ message: 'Login successful.' });
}

async function logout(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  clearSessionCookie(res);
  return res.status(200).json({ message: 'Logged out successfully.' });
}

async function session(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  const current = getSession(req);
  if (!current) return res.status(401).json({ error: 'No active session.' });
  return res.status(200).json({ authenticated: true });
}

module.exports = async function handler(req, res) {
  try {
    const route = action(req);
    if (route === 'login') return login(req, res);
    if (route === 'logout') return logout(req, res);
    if (route === 'session') return session(req, res);
    return res.status(404).json({ error: 'Authentication action not found.' });
  } catch (error) {
    console.error('Auth API error:', error);
    return res.status(500).json({ error: 'Authentication request failed.' });
  }
};
