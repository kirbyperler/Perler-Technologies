const crypto = require('crypto');
const { put } = require('@vercel/blob');
const { formidable } = require('formidable');
const fs = require('node:fs/promises');

const { getDb, toObjectId, serialize } = require('../lib/db');
const { allowMethods, action, jsonBody } = require('../lib/http');
const { requireAdmin } = require('../lib/auth');
const { clean } = require('../lib/validation');
const { isValidTokenFormat } = require('../lib/tokens');
const { checkRateLimit, recordRateLimitHit } = require('../lib/rateLimit');
const { sendCompletionNotificationEmail } = require('../lib/email');
const {
  normalizeAnswers,
  computeCompletionPercentage,
  findMissingRequiredAnswers,
  findSkippedQuestions
} = require('../lib/questionnaire-logic');
const {
  flattenOrdered,
  MAX_FILE_SIZE_BYTES,
  ALLOWED_FILE_EXTENSIONS,
  allowedMimeTypesFor
} = require('../lib/questionnaire-validation');

const RATE_LIMIT_BUCKET = 'questionnaire-respond';

// Same forward-only lifecycle as api/questionnaires.js's advanceProjectDiscoveryStatus
// -- intentionally duplicated rather than shared; see that file's comment for why.
const DISCOVERY_STATUS_ORDER = ['Not Started', 'Sent', 'Viewed', 'In Progress', 'Complete'];

async function advanceProjectDiscoveryStatus(db, projectId, newStatus) {
  if (!projectId) return;
  const project = await db.collection('projects').findOne({ _id: projectId }, { projection: { discoveryStatus: 1 } });
  if (!project) return;
  const currentIndex = DISCOVERY_STATUS_ORDER.indexOf(project.discoveryStatus || 'Not Started');
  const newIndex = DISCOVERY_STATUS_ORDER.indexOf(newStatus);
  if (newIndex <= currentIndex) return;
  await db.collection('projects').updateOne({ _id: projectId }, { $set: { discoveryStatus: newStatus, updatedAt: new Date() } });
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// respondGet is rate-limited by IP (each guess uses a different token, so limiting by
// token wouldn't slow down guessing at all). autosave/submit/uploadFile are
// rate-limited by token instead (the token is already valid at that point -- this is
// about throttling abuse of one link, not guessing).
async function enforceRateLimit(res, db, key, options) {
  const limitCheck = await checkRateLimit(db, RATE_LIMIT_BUCKET, key);
  if (limitCheck.limited) {
    res.setHeader('Retry-After', String(limitCheck.retryAfterSeconds));
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return false;
  }
  await recordRateLimitHit(db, RATE_LIMIT_BUCKET, key, options);
  return true;
}

// Explicit whitelist -- a public respondent must never see clientId, projectId,
// linkedInvoiceId, recipientEmail, accessToken, reminderCount, or any other
// admin/internal field, even by accident from a future field being added upstream.
function toPublicQuestionnaire(questionnaire) {
  return {
    id: String(questionnaire._id),
    title: questionnaire.title,
    description: questionnaire.description,
    sections: questionnaire.sections,
    status: questionnaire.status
  };
}

function toPublicResponse(responseDoc) {
  return {
    answers: responseDoc.answers || {},
    currentSectionId: responseDoc.currentSectionId || null,
    completionPercentage: responseDoc.completionPercentage || 0,
    submittedAt: responseDoc.submittedAt || null
  };
}

// Resolves a questionnaire by token, applying every gate a public caller must pass:
// well-formed token, exists, not still a Draft (never sent -- nothing to see yet),
// not Archived, and not expired. Returns { error, status } on failure so callers can
// respond consistently; { questionnaire } on success.
async function resolvePublicQuestionnaire(db, rawToken, now) {
  if (typeof rawToken !== 'string' || !isValidTokenFormat(rawToken)) {
    return { error: 'Questionnaire not found.', status: 404 };
  }
  const questionnaire = await db.collection('questionnaires').findOne({ accessToken: rawToken });
  if (!questionnaire || questionnaire.status === 'Draft') {
    return { error: 'Questionnaire not found.', status: 404 };
  }
  if (questionnaire.status === 'Archived') {
    return { error: 'This questionnaire is no longer available.', status: 410 };
  }
  if (questionnaire.tokenExpiresAt && new Date(questionnaire.tokenExpiresAt) < now && questionnaire.status !== 'Completed') {
    return { error: 'This questionnaire link has expired. Please contact Perler Technologies for a new link.', status: 410 };
  }
  return { questionnaire };
}

async function respondGet(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;
  res.setHeader('Cache-Control', 'no-store');

  if (!(await enforceRateLimit(res, db, clientIp(req), { maxAttempts: 40, windowMs: 5 * 60 * 1000, lockMs: 15 * 60 * 1000 }))) return;

  const now = new Date();
  const resolved = await resolvePublicQuestionnaire(db, req.query?.token, now);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  let { questionnaire } = resolved;

  let responseDoc = await db.collection('questionnaireResponses').findOne({ questionnaireId: questionnaire._id });
  if (!responseDoc) {
    const newResponse = {
      questionnaireId: questionnaire._id,
      answers: {},
      currentSectionId: null,
      completionPercentage: 0,
      startedAt: null,
      firstViewedAt: now,
      lastViewedAt: now,
      lastActivityAt: now,
      submittedAt: null,
      timeToCompleteSeconds: null,
      skippedQuestionIds: [],
      adminNotes: '',
      reopenCount: 0,
      createdAt: now,
      updatedAt: now
    };
    const result = await db.collection('questionnaireResponses').insertOne(newResponse);
    responseDoc = { ...newResponse, _id: result.insertedId };
  } else {
    await db.collection('questionnaireResponses').updateOne({ _id: responseDoc._id }, { $set: { lastViewedAt: now, updatedAt: now } });
  }

  // Sent -> Viewed happens on the very first open; later opens just bump lastViewedAt.
  if (questionnaire.status === 'Sent') {
    await db.collection('questionnaires').updateOne({ _id: questionnaire._id }, { $set: {
      status: 'Viewed',
      'progress.firstViewedAt': responseDoc.firstViewedAt,
      'progress.lastViewedAt': now,
      updatedAt: now
    } });
    await advanceProjectDiscoveryStatus(db, questionnaire.projectId, 'Viewed');
    questionnaire = { ...questionnaire, status: 'Viewed' };
  } else {
    await db.collection('questionnaires').updateOne({ _id: questionnaire._id }, { $set: { 'progress.lastViewedAt': now, updatedAt: now } });
  }

  return res.status(200).json({
    questionnaire: toPublicQuestionnaire(questionnaire),
    response: toPublicResponse(responseDoc)
  });
}

async function autosave(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  res.setHeader('Cache-Control', 'no-store');
  const body = jsonBody(req);

  const rawToken = body.token;
  if (!(await enforceRateLimit(res, db, typeof rawToken === 'string' ? rawToken : 'invalid', { maxAttempts: 240, windowMs: 5 * 60 * 1000, lockMs: 10 * 60 * 1000 }))) return;

  const now = new Date();
  const resolved = await resolvePublicQuestionnaire(db, rawToken, now);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { questionnaire } = resolved;

  if (['Completed', 'Archived'].includes(questionnaire.status)) {
    return res.status(409).json({ error: 'This questionnaire can no longer be edited.' });
  }

  const responseDoc = await db.collection('questionnaireResponses').findOne({ questionnaireId: questionnaire._id });
  if (!responseDoc) return res.status(404).json({ error: 'Open the questionnaire before saving progress.' });

  const cleanAnswers = normalizeAnswers(questionnaire.sections, body.answers);
  const completionPercentage = computeCompletionPercentage(questionnaire.sections, cleanAnswers);
  const currentSectionId = clean(body.currentSectionId, 100) || responseDoc.currentSectionId || null;

  const responseUpdates = {
    answers: cleanAnswers,
    currentSectionId,
    completionPercentage,
    lastActivityAt: now,
    updatedAt: now
  };
  if (!responseDoc.startedAt) responseUpdates.startedAt = now;
  await db.collection('questionnaireResponses').updateOne({ _id: responseDoc._id }, { $set: responseUpdates });

  const questionnaireUpdates = { 'progress.completionPercentage': completionPercentage, updatedAt: now };
  if (!responseDoc.startedAt) questionnaireUpdates['progress.startedAt'] = now;
  const movingToInProgress = questionnaire.status === 'Viewed' && Object.keys(cleanAnswers).length > 0;
  if (movingToInProgress) questionnaireUpdates.status = 'InProgress';
  await db.collection('questionnaires').updateOne({ _id: questionnaire._id }, { $set: questionnaireUpdates });
  if (movingToInProgress) await advanceProjectDiscoveryStatus(db, questionnaire.projectId, 'In Progress');

  return res.status(200).json({ success: true, completionPercentage });
}

async function submit(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  res.setHeader('Cache-Control', 'no-store');
  const body = jsonBody(req);

  const rawToken = body.token;
  if (!(await enforceRateLimit(res, db, typeof rawToken === 'string' ? rawToken : 'invalid', { maxAttempts: 20, windowMs: 5 * 60 * 1000, lockMs: 10 * 60 * 1000 }))) return;

  const now = new Date();
  const resolved = await resolvePublicQuestionnaire(db, rawToken, now);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { questionnaire } = resolved;

  // Prevents duplicate submissions unless the admin reopens it (a future admin action
  // that will flip status back off Completed -- not built this phase).
  if (questionnaire.status === 'Completed') {
    return res.status(409).json({ error: 'This questionnaire has already been submitted.' });
  }

  const responseDoc = await db.collection('questionnaireResponses').findOne({ questionnaireId: questionnaire._id });
  if (!responseDoc) return res.status(404).json({ error: 'Open the questionnaire before submitting.' });

  // Never trust the client's own idea of "complete" -- required-field validation
  // always happens server-side, against the questionnaire's own conditional logic.
  const cleanAnswers = normalizeAnswers(questionnaire.sections, body.answers ?? responseDoc.answers);
  const missingQuestionIds = findMissingRequiredAnswers(questionnaire.sections, cleanAnswers);
  if (missingQuestionIds.length) {
    return res.status(400).json({ error: 'Please answer all required questions before submitting.', missingQuestionIds });
  }

  const skippedQuestionIds = findSkippedQuestions(questionnaire.sections, cleanAnswers);
  const startedAt = responseDoc.startedAt || responseDoc.firstViewedAt || now;
  const timeToCompleteSeconds = Math.max(0, Math.round((now.getTime() - new Date(startedAt).getTime()) / 1000));

  await db.collection('questionnaireResponses').updateOne({ _id: responseDoc._id }, { $set: {
    answers: cleanAnswers,
    completionPercentage: 100,
    submittedAt: now,
    skippedQuestionIds,
    lastActivityAt: now,
    updatedAt: now
  } });

  await db.collection('questionnaires').updateOne({ _id: questionnaire._id }, { $set: {
    status: 'Completed',
    'progress.completionPercentage': 100,
    'progress.submittedAt': now,
    'progress.timeToCompleteSeconds': timeToCompleteSeconds,
    updatedAt: now
  } });

  await advanceProjectDiscoveryStatus(db, questionnaire.projectId, 'Complete');

  // Best-effort: a failed notification email must never fail the submission itself
  // (the response is already safely saved above).
  try {
    const [client, project] = await Promise.all([
      questionnaire.clientId ? db.collection('clients').findOne({ _id: questionnaire.clientId }) : null,
      questionnaire.projectId ? db.collection('projects').findOne({ _id: questionnaire.projectId }) : null
    ]);
    await sendCompletionNotificationEmail(db, {
      questionnaire,
      clientName: client?.name || null,
      projectName: project?.name || null
    });
  } catch (error) {
    console.error('Completion notification email failed:', error.message);
  }

  return res.status(200).json({ success: true, submittedAt: now });
}

function parseForm(req, maxFileSize) {
  return new Promise((resolve, reject) => {
    const form = formidable({ maxFileSize, multiples: false });
    form.parse(req, (error, fields, files) => {
      if (error) return reject(error);
      resolve({ fields, files });
    });
  });
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

// formidable's internal error codes for an oversized upload (see
// node_modules/formidable/src/FormidableError.js).
function isUploadSizeError(error) {
  return error?.code === 1016 || error?.code === 1009;
}

// Never derives the storage path from the original filename -- only a random name
// plus an extension pulled from a fixed allowlist. The original filename is kept
// purely as display metadata (originalName), never used to build a path.
function safeStorageFilename(originalName) {
  const ext = String(originalName || '').split('.').pop().toLowerCase();
  const safeExt = ALLOWED_FILE_EXTENSIONS.includes(ext) ? ext : 'bin';
  return `${crypto.randomBytes(16).toString('hex')}.${safeExt}`;
}

async function uploadFile(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  res.setHeader('Cache-Control', 'no-store');

  let parsed;
  try {
    parsed = await parseForm(req, MAX_FILE_SIZE_BYTES);
  } catch (error) {
    console.error('Questionnaire file upload parse error:', error);
    return res.status(400).json({
      error: isUploadSizeError(error) ? 'The file exceeds the maximum allowed size.' : 'The uploaded file could not be read.'
    });
  }

  const rawToken = first(parsed.fields.token);
  if (!(await enforceRateLimit(res, db, typeof rawToken === 'string' ? rawToken : 'invalid', { maxAttempts: 30, windowMs: 5 * 60 * 1000, lockMs: 10 * 60 * 1000 }))) return;

  const now = new Date();
  const resolved = await resolvePublicQuestionnaire(db, rawToken, now);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { questionnaire } = resolved;

  if (['Completed', 'Archived'].includes(questionnaire.status)) {
    return res.status(409).json({ error: 'This questionnaire can no longer be edited.' });
  }

  const questionId = clean(first(parsed.fields.questionId), 100);
  const targetNode = flattenOrdered(questionnaire.sections).find(entry => entry.nodeType === 'question' && entry.id === questionId);
  if (!targetNode || !['file_upload', 'image_upload'].includes(targetNode.node.type)) {
    return res.status(400).json({ error: 'Invalid question for a file upload.' });
  }

  const uploaded = first(parsed.files.file);
  if (!uploaded) return res.status(400).json({ error: 'No file was uploaded.' });

  const mimeType = String(uploaded.mimetype || 'application/octet-stream').toLowerCase();
  const allowedTypes = allowedMimeTypesFor(targetNode.node.type);
  if (!allowedTypes.includes(mimeType)) {
    return res.status(400).json({ error: `This file type isn't allowed for this question. Allowed types: ${allowedTypes.join(', ')}.` });
  }

  const originalName = String(uploaded.originalFilename || 'file').slice(0, 300);
  const storageName = safeStorageFilename(originalName);
  const pathname = `questionnaires/${questionnaire._id}/${questionId}/${storageName}`;

  let blob;
  try {
    const buffer = await fs.readFile(uploaded.filepath);
    blob = await put(pathname, buffer, { access: 'public', contentType: mimeType, addRandomSuffix: true });
  } catch (error) {
    console.error('Questionnaire file blob upload error:', error.message);
    return res.status(500).json({ error: 'The file could not be uploaded. Please try again.' });
  }

  const fileDocument = {
    questionnaireId: questionnaire._id,
    questionId,
    originalName,
    safeName: storageName,
    contentType: mimeType,
    size: Number(uploaded.size || 0),
    blobUrl: blob.url,
    blobPathname: blob.pathname,
    uploadedAt: now
  };
  const result = await db.collection('questionnaireFiles').insertOne(fileDocument);

  return res.status(201).json({
    fileId: String(result.insertedId),
    originalName,
    size: fileDocument.size,
    url: blob.url
  });
}

// ---------- Admin-gated review actions ----------

async function adminList(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;

  const filter = {};
  const questionnaireId = toObjectId(req.query?.questionnaireId);
  if (questionnaireId) filter.questionnaireId = questionnaireId;

  const responses = await db.collection('questionnaireResponses').find(filter).sort({ updatedAt: -1 }).limit(500).toArray();
  return res.status(200).json({ responses: responses.map(serialize) });
}

async function adminGet(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;

  const id = toObjectId(req.query?.id);
  const questionnaireId = toObjectId(req.query?.questionnaireId);
  if (!id && !questionnaireId) return res.status(400).json({ error: 'A response ID or questionnaire ID is required.' });

  const responseDoc = id
    ? await db.collection('questionnaireResponses').findOne({ _id: id })
    : await db.collection('questionnaireResponses').findOne({ questionnaireId });
  if (!responseDoc) return res.status(404).json({ error: 'Response not found.' });

  const files = await db.collection('questionnaireFiles').find({ questionnaireId: responseDoc.questionnaireId }).toArray();

  return res.status(200).json({ response: serialize(responseDoc), files: files.map(serialize) });
}

module.exports = async function handler(req, res) {
  try {
    const db = await getDb();
    const route = action(req);

    // Public, token-gated actions -- dispatched before requireAdmin, mirroring
    // api/invoices.js's public/createCheckout actions.
    if (route === 'respondget') return respondGet(req, res, db);
    if (route === 'autosave') return autosave(req, res, db);
    if (route === 'submit') return submit(req, res, db);
    if (route === 'uploadfile') return uploadFile(req, res, db);

    const session = requireAdmin(req, res);
    if (!session) return;

    if (route === 'list') return adminList(req, res, db);
    if (route === 'get') return adminGet(req, res, db);
    return res.status(404).json({ error: 'Questionnaire response action not found.' });
  } catch (error) {
    console.error('Questionnaire responses API error:', error);
    return res.status(500).json({ error: 'The request could not be completed.' });
  }
};
