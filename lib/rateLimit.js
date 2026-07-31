// Generic version of the Mongo-backed lockout pattern already used for admin login
// attempts (see lib/auth.js's getLoginLock/recordLoginFailure/resetLoginAttempts).
// Tracked in MongoDB rather than in-memory so the limit holds up across the many
// short-lived serverless instances a Vercel deployment can run behind.
//
// Used to slow down brute-forcing of questionnaire access tokens on the public
// respond endpoints (autosave/submit/uploadFile), which have no login/lockout of
// their own since respondents never authenticate.

const rateLimitsCollection = db => db.collection('rate_limits');

// `bucket` namespaces the limit (e.g. "questionnaire-respond"), `key` identifies who's
// being limited (e.g. a token or "token:ip"). Combined into one _id so unrelated
// buckets never collide.
function rowId(bucket, key) {
  return `${bucket}:${key}`;
}

async function checkRateLimit(db, bucket, key) {
  const doc = await rateLimitsCollection(db).findOne({ _id: rowId(bucket, key) });
  if (doc?.lockedUntil && doc.lockedUntil > new Date()) {
    return { limited: true, retryAfterSeconds: Math.ceil((doc.lockedUntil.getTime() - Date.now()) / 1000) };
  }
  return { limited: false };
}

// Call after every request the bucket should count against the limit (not just
// failures — public token endpoints rate-limit by request volume, not by success vs
// failure, since the goal is slowing down guessing/scripted abuse rather than
// punishing a legitimate respondent's typos).
async function recordRateLimitHit(db, bucket, key, { maxAttempts = 60, windowMs = 5 * 60 * 1000, lockMs = 10 * 60 * 1000 } = {}) {
  const now = new Date();
  const collection = rateLimitsCollection(db);
  const id = rowId(bucket, key);
  const existing = await collection.findOne({ _id: id });

  const withinWindow = existing?.firstHitAt && existing.firstHitAt.getTime() > now.getTime() - windowMs;
  const hitCount = withinWindow ? (existing.hitCount || 0) + 1 : 1;

  await collection.updateOne(
    { _id: id },
    { $set: {
      hitCount,
      firstHitAt: withinWindow ? existing.firstHitAt : now,
      lockedUntil: hitCount >= maxAttempts ? new Date(now.getTime() + lockMs) : null,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) // TTL cleanup, see scripts/create-indexes.js
    } },
    { upsert: true }
  );
}

module.exports = { checkRateLimit, recordRateLimitHit };
