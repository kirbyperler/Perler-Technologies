const { createHmac, timingSafeEqual } = require('crypto');

const SESSION_COOKIE = 'perler_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const MAX_LOGIN_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function readCookie(req, name) {
  const header = req.headers?.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function signSession(payload) {
  if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET is missing.');
  const data = { ...payload, expiresAt: Date.now() + SESSION_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = createHmac('sha256', process.env.SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || !process.env.SESSION_SECRET) return null;
  const [payloadPart, signaturePart] = token.split('.');
  if (!payloadPart || !signaturePart) return null;

  const expected = createHmac('sha256', process.env.SESSION_SECRET).update(payloadPart).digest('base64url');
  const a = Buffer.from(signaturePart);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (Number(payload.expiresAt || 0) < Date.now()) return null;
    if (payload.role !== 'Admin' || !payload.adminId) return null;
    return { adminId: String(payload.adminId), role: 'Admin', expiresAt: payload.expiresAt };
  } catch {
    return null;
  }
}

function cookieFlags(maxAgeSeconds) {
  const parts = ['Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Strict'];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', [`${SESSION_COOKIE}=${token}`, ...cookieFlags(SESSION_TTL_MS / 1000)].join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', [`${SESSION_COOKIE}=`, ...cookieFlags(0)].join('; '));
}

function getSession(req) {
  return verifySessionToken(readCookie(req, SESSION_COOKIE));
}

function requireAdmin(req, res) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'You must be logged in.' });
    return null;
  }
  return session;
}

// Login attempts are tracked in MongoDB (not in-memory) so the limit holds up across
// the many short-lived serverless instances a Vercel deployment can run behind.
async function getLoginLock(db, email) {
  const doc = await db.collection('login_attempts').findOne({ _id: email });
  if (doc?.lockedUntil && doc.lockedUntil > new Date()) {
    return { locked: true, retryAfterSeconds: Math.ceil((doc.lockedUntil.getTime() - Date.now()) / 1000) };
  }
  return { locked: false };
}

async function recordLoginFailure(db, email) {
  const now = new Date();
  const collection = db.collection('login_attempts');
  const existing = await collection.findOne({ _id: email });

  const withinWindow = existing?.firstFailAt && existing.firstFailAt.getTime() > now.getTime() - ATTEMPT_WINDOW_MS;
  const failCount = withinWindow ? (existing.failCount || 0) + 1 : 1;

  const update = {
    failCount,
    firstFailAt: withinWindow ? existing.firstFailAt : now,
    lockedUntil: failCount >= MAX_LOGIN_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_MS) : null,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) // TTL cleanup, see scripts/create-indexes.js
  };
  await collection.updateOne({ _id: email }, { $set: update }, { upsert: true });
}

async function resetLoginAttempts(db, email) {
  await db.collection('login_attempts').deleteOne({ _id: email });
}

module.exports = {
  SESSION_COOKIE,
  signSession,
  verifySessionToken,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  requireAdmin,
  getLoginLock,
  recordLoginFailure,
  resetLoginAttempts
};
