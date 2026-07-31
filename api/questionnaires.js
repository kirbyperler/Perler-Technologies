const { getDb, toObjectId, serialize } = require('../lib/db');
const { allowMethods, action, jsonBody } = require('../lib/http');
const { requireAdmin } = require('../lib/auth');
const { clean, isValidEmail } = require('../lib/validation');
const { sanitizeQuestionnaireContent } = require('../lib/questionnaire-validation');
const { generateSecureToken } = require('../lib/tokens');
const { sendQuestionnaireInviteEmail } = require('../lib/email');
const { batchFetchByIds } = require('../lib/relations');

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // default: 90 days from send/resend/remind

// Admin may optionally override the link's expiration date (send/resend/remind).
// Falls back to the 90-day default when absent, invalid, or not in the future.
function resolveExpiresAt(body) {
  if (body.expiresAt) {
    const date = new Date(body.expiresAt);
    if (!Number.isNaN(date.getTime()) && date.getTime() > Date.now()) return date;
  }
  return new Date(Date.now() + TOKEN_TTL_MS);
}

const SORT_OPTIONS = {
  newest: { createdAt: -1 },
  title: { title: 1 },
  lastactivity: { updatedAt: -1 }
};

const EMPTY_PROGRESS = {
  completionPercentage: 0,
  firstViewedAt: null,
  lastViewedAt: null,
  startedAt: null,
  submittedAt: null,
  timeToCompleteSeconds: null
};

function siteBase() {
  return (process.env.SITE_URL || 'https://perlertechnologies.com').replace(/\/$/, '');
}

function respondLinkFor(token) {
  return token ? `${siteBase()}/questionnaire/${token}` : null;
}

// "Expired" is never stored -- derived the same way invoices.js derives "Overdue"
// from dueDate + status, so the browser can never claim a link is (or isn't) expired
// on its own.
function effectiveStatus(questionnaire, now) {
  if (
    questionnaire.tokenExpiresAt &&
    new Date(questionnaire.tokenExpiresAt) < now &&
    !['Completed', 'Archived'].includes(questionnaire.status)
  ) {
    return 'Expired';
  }
  return questionnaire.status;
}

// A project can only ever move forward through the discovery lifecycle from
// questionnaire events (Sent -> Viewed -> In Progress -> Complete) -- resending or
// duplicating an old questionnaire can never regress a project's discoveryStatus.
// Intentionally duplicated (unchanged) in api/questionnaire-responses.js: small
// enough that a shared module for one write would be more overhead than the
// duplication itself.
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

function toListItem(questionnaire, now, clientById, projectById) {
  const client = clientById.get(String(questionnaire.clientId));
  const project = projectById.get(String(questionnaire.projectId));
  return {
    id: String(questionnaire._id),
    title: questionnaire.title,
    status: effectiveStatus(questionnaire, now),
    clientId: questionnaire.clientId ? String(questionnaire.clientId) : null,
    clientName: client?.name || questionnaire.clientNameSnapshot || null,
    projectId: questionnaire.projectId ? String(questionnaire.projectId) : null,
    projectName: project?.name || null,
    sourceTemplateId: questionnaire.sourceTemplateId ? String(questionnaire.sourceTemplateId) : null,
    sentAt: questionnaire.sentAt,
    lastEmailSentAt: questionnaire.lastEmailSentAt,
    progress: questionnaire.progress || EMPTY_PROGRESS,
    createdAt: questionnaire.createdAt,
    updatedAt: questionnaire.updatedAt
  };
}

function toDetail(questionnaire, now) {
  return {
    ...serialize(questionnaire),
    status: effectiveStatus(questionnaire, now),
    respondLink: respondLinkFor(questionnaire.accessToken)
  };
}

// Validates the three optional attachment fields shared by createFromTemplate,
// createBlank, and update. Linking to a project always adopts that project's own
// clientId as authoritative (a project belongs to exactly one client), so the two
// can never silently disagree.
async function resolveAttachments(db, body) {
  let clientId = null;
  let projectId = null;
  let linkedInvoiceId = null;

  if (body.projectId) {
    projectId = toObjectId(body.projectId);
    if (!projectId) return { error: 'Invalid project reference.' };
    const project = await db.collection('projects').findOne({ _id: projectId });
    if (!project) return { error: 'Project not found.' };
    clientId = project.clientId;
  } else if (body.clientId) {
    clientId = toObjectId(body.clientId);
    if (!clientId) return { error: 'Invalid client reference.' };
    const client = await db.collection('clients').findOne({ _id: clientId });
    if (!client) return { error: 'Client not found.' };
  }

  if (body.linkedInvoiceId) {
    linkedInvoiceId = toObjectId(body.linkedInvoiceId);
    if (!linkedInvoiceId) return { error: 'Invalid invoice reference.' };
    const invoice = await db.collection('invoices').findOne({ _id: linkedInvoiceId });
    if (!invoice) return { error: 'Invoice not found.' };
  }

  return { clientId, projectId, linkedInvoiceId };
}

// Shared by list() and dashboard(): batch-fetches client/project names for a set of
// questionnaires (avoids an N+1 lookup per row).
async function joinClientProjectNames(db, questionnaires) {
  const [clientById, projectById] = await Promise.all([
    batchFetchByIds(db, 'clients', questionnaires.map(q => q.clientId), { name: 1 }),
    batchFetchByIds(db, 'projects', questionnaires.map(q => q.projectId), { name: 1 })
  ]);
  return { clientById, projectById };
}

async function list(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;
  const now = new Date();

  const filter = {};
  const clientId = toObjectId(req.query?.clientId);
  if (clientId) filter.clientId = clientId;

  const projectId = toObjectId(req.query?.projectId);
  if (projectId) filter.projectId = projectId;

  const templateId = toObjectId(req.query?.templateId);
  if (templateId) filter.sourceTemplateId = templateId;

  const sortKey = clean(req.query?.sort, 30).toLowerCase();
  const sort = SORT_OPTIONS[sortKey] || SORT_OPTIONS.newest;

  const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200);
  const skip = Math.max(Number(req.query?.skip) || 0, 0);

  // Fetched without a hard limit before pagination so status filtering (which
  // depends on the *derived* Expired status) and pagination stay consistent --
  // mirrors invoices.js's list(), which does the same status-filter-after-fetch.
  const questionnaires = await db.collection('questionnaires').find(filter).sort(sort).limit(2000).toArray();
  const { clientById, projectById } = await joinClientProjectNames(db, questionnaires);

  // Search matches title OR the joined client/project name -- there's no stored
  // client/project name field on the questionnaire to $regex directly against.
  const search = clean(req.query?.search, 100).toLowerCase();
  const matchesSearch = item => !search
    || item.title.toLowerCase().includes(search)
    || (item.clientName || '').toLowerCase().includes(search)
    || (item.projectName || '').toLowerCase().includes(search);

  // Comma-separated so the admin "Pending" list view can request the whole
  // Published/Sent/Viewed/InProgress bucket in one call.
  const statusFilter = clean(req.query?.status, 100).split(',').map(s => s.trim()).filter(Boolean);

  let items = questionnaires
    .map(q => toListItem(q, now, clientById, projectById))
    .filter(item => !statusFilter.length || statusFilter.includes(item.status))
    .filter(matchesSearch);

  if (sortKey === 'client') items = items.sort((a, b) => (a.clientName || '').localeCompare(b.clientName || ''));
  else if (sortKey === 'project') items = items.sort((a, b) => (a.projectName || '').localeCompare(b.projectName || ''));
  else if (sortKey === 'oldest') items = items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return res.status(200).json({
    questionnaires: items.slice(skip, skip + limit),
    total: items.length
  });
}

async function dashboard(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;
  const now = new Date();

  const [templateCount, questionnaires] = await Promise.all([
    db.collection('questionnaireTemplates').countDocuments({}),
    db.collection('questionnaires').find({}, { projection: { sections: 0 } }).sort({ createdAt: -1 }).limit(2000).toArray()
  ]);
  const { clientById, projectById } = await joinClientProjectNames(db, questionnaires);

  let draftCount = 0, pendingCount = 0, inProgressCount = 0, completedCount = 0, sentCount = 0;
  let completionTimeTotalSeconds = 0, completionTimeSamples = 0;

  for (const q of questionnaires) {
    const status = effectiveStatus(q, now);
    if (status === 'Draft') draftCount += 1;
    else if (['Published', 'Sent', 'Viewed'].includes(status)) pendingCount += 1;
    else if (status === 'InProgress') inProgressCount += 1;
    else if (status === 'Completed') completedCount += 1;

    if (q.sentAt) sentCount += 1;
    if (status === 'Completed' && typeof q.progress?.timeToCompleteSeconds === 'number') {
      completionTimeTotalSeconds += q.progress.timeToCompleteSeconds;
      completionTimeSamples += 1;
    }
  }

  const items = questionnaires.map(q => toListItem(q, now, clientById, projectById));
  const recentQuestionnaires = items.slice(0, 5);
  const recentlyCompleted = items
    .filter(item => item.status === 'Completed')
    .sort((a, b) => new Date(b.progress?.submittedAt || 0) - new Date(a.progress?.submittedAt || 0))
    .slice(0, 5);

  return res.status(200).json({
    totalQuestionnaires: questionnaires.length,
    templateCount,
    draftCount,
    pendingCount,
    inProgressCount,
    completedCount,
    completionRate: sentCount ? Math.round((completedCount / sentCount) * 100) : 0,
    averageCompletionTimeSeconds: completionTimeSamples ? Math.round(completionTimeTotalSeconds / completionTimeSamples) : null,
    recentQuestionnaires,
    recentlyCompleted
  });
}

async function get(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;
  const id = toObjectId(req.query?.id);
  if (!id) return res.status(404).json({ error: 'Questionnaire not found.' });

  const questionnaire = await db.collection('questionnaires').findOne({ _id: id });
  if (!questionnaire) return res.status(404).json({ error: 'Questionnaire not found.' });

  const [client, project] = await Promise.all([
    questionnaire.clientId ? db.collection('clients').findOne({ _id: questionnaire.clientId }) : null,
    questionnaire.projectId ? db.collection('projects').findOne({ _id: questionnaire.projectId }) : null
  ]);

  return res.status(200).json({
    questionnaire: toDetail(questionnaire, new Date()),
    client: client ? serialize(client) : null,
    project: project ? serialize(project) : null
  });
}

async function createFromTemplate(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);

  const templateId = toObjectId(body.templateId);
  if (!templateId) return res.status(400).json({ error: 'A valid template is required.' });
  const template = await db.collection('questionnaireTemplates').findOne({ _id: templateId });
  if (!template) return res.status(404).json({ error: 'Template not found.' });

  const attachments = await resolveAttachments(db, body);
  if (attachments.error) return res.status(400).json({ error: attachments.error });

  const title = clean(body.title, 200) || template.title;

  const now = new Date();
  const document = {
    title,
    description: template.description,
    // Deep copy -- this questionnaire's content is now fully independent of the
    // template. Later template edits (which bump template.version) can never alter
    // it. See sourceTemplateVersion below for traceability.
    sections: JSON.parse(JSON.stringify(template.sections)),
    sourceTemplateId: template._id,
    sourceTemplateVersion: template.version,
    clientId: attachments.clientId,
    projectId: attachments.projectId,
    linkedInvoiceId: attachments.linkedInvoiceId,
    status: 'Draft',
    accessToken: generateSecureToken(),
    tokenExpiresAt: null,
    recipientEmail: null,
    sentAt: null,
    lastEmailSentAt: null,
    reminderCount: 0,
    progress: { ...EMPTY_PROGRESS },
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  };

  const result = await db.collection('questionnaires').insertOne(document);
  return res.status(201).json({ questionnaire: toDetail({ ...document, _id: result.insertedId }, now) });
}

async function createBlank(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);

  const { errors, title, description, sections } = sanitizeQuestionnaireContent(body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const attachments = await resolveAttachments(db, body);
  if (attachments.error) return res.status(400).json({ error: attachments.error });

  const now = new Date();
  const document = {
    title, description, sections,
    sourceTemplateId: null,
    sourceTemplateVersion: null,
    clientId: attachments.clientId,
    projectId: attachments.projectId,
    linkedInvoiceId: attachments.linkedInvoiceId,
    status: 'Draft',
    accessToken: generateSecureToken(),
    tokenExpiresAt: null,
    recipientEmail: null,
    sentAt: null,
    lastEmailSentAt: null,
    reminderCount: 0,
    progress: { ...EMPTY_PROGRESS },
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  };

  const result = await db.collection('questionnaires').insertOne(document);
  return res.status(201).json({ questionnaire: toDetail({ ...document, _id: result.insertedId }, now) });
}

// Shared by the "update" and "saveDraft" actions. Both re-validate + replace content
// and optionally reassign client/project/invoice; saveDraft additionally forces the
// status back to Draft (e.g. pulling a Published questionnaire back for more editing
// before it's sent), while update leaves status untouched. Content is locked once a
// questionnaire has actually been sent, so the exact wording a respondent already saw
// can never change out from under them -- forceDraftStatus does not bypass that lock.
async function updateContent(req, res, db, forceDraftStatus) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid questionnaire ID is required.' });

  const existing = await db.collection('questionnaires').findOne({ _id: id });
  if (!existing) return res.status(404).json({ error: 'Questionnaire not found.' });

  if (forceDraftStatus && !['Draft', 'Published'].includes(existing.status)) {
    return res.status(409).json({ error: 'This questionnaire has already been sent and can no longer be pulled back to a draft.' });
  }

  const updates = { updatedAt: new Date() };
  if (forceDraftStatus) updates.status = 'Draft';

  const editingContent = ['title', 'description', 'sections'].some(key => Object.prototype.hasOwnProperty.call(body, key));
  if (editingContent) {
    if (!['Draft', 'Published'].includes(existing.status)) {
      return res.status(409).json({ error: 'This questionnaire has already been sent, so its content is locked and can no longer be edited.' });
    }
    const { errors, title, description, sections } = sanitizeQuestionnaireContent({
      title: body.title ?? existing.title,
      description: body.description ?? existing.description,
      sections: body.sections ?? existing.sections
    });
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    Object.assign(updates, { title, description, sections });
  }

  // Each attachment is handled independently (rather than reusing resolveAttachments,
  // which assumes all three are fresh) so a partial update can explicitly clear one
  // field -- pass an empty/falsy value to clear, omit the key entirely to leave it
  // untouched, matching the convention already used for optional text fields
  // elsewhere (e.g. api/clients.js's phone/businessName updates).
  if (Object.prototype.hasOwnProperty.call(body, 'projectId')) {
    if (body.projectId) {
      const projectId = toObjectId(body.projectId);
      if (!projectId) return res.status(400).json({ error: 'Invalid project reference.' });
      const project = await db.collection('projects').findOne({ _id: projectId });
      if (!project) return res.status(404).json({ error: 'Project not found.' });
      updates.projectId = projectId;
      updates.clientId = project.clientId; // a project always determines its client
    } else {
      updates.projectId = null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'clientId') && !Object.prototype.hasOwnProperty.call(body, 'projectId')) {
    if (body.clientId) {
      const clientId = toObjectId(body.clientId);
      if (!clientId) return res.status(400).json({ error: 'Invalid client reference.' });
      const client = await db.collection('clients').findOne({ _id: clientId });
      if (!client) return res.status(404).json({ error: 'Client not found.' });
      updates.clientId = clientId;
    } else {
      updates.clientId = null;
      updates.projectId = null; // a linked project can't outlive its client on this record
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'linkedInvoiceId')) {
    if (body.linkedInvoiceId) {
      const linkedInvoiceId = toObjectId(body.linkedInvoiceId);
      if (!linkedInvoiceId) return res.status(400).json({ error: 'Invalid invoice reference.' });
      const invoice = await db.collection('invoices').findOne({ _id: linkedInvoiceId });
      if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
      updates.linkedInvoiceId = linkedInvoiceId;
    } else {
      updates.linkedInvoiceId = null;
    }
  }

  await db.collection('questionnaires').updateOne({ _id: id }, { $set: updates });
  const updated = await db.collection('questionnaires').findOne({ _id: id });
  return res.status(200).json({ questionnaire: toDetail(updated, new Date()) });
}

async function publish(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid questionnaire ID is required.' });

  const questionnaire = await db.collection('questionnaires').findOne({ _id: id });
  if (!questionnaire) return res.status(404).json({ error: 'Questionnaire not found.' });
  if (questionnaire.status !== 'Draft') return res.status(409).json({ error: 'Only a draft questionnaire can be published.' });

  const questionCount = (questionnaire.sections || []).reduce((sum, section) => sum + (section.questions || []).length, 0);
  if (!questionCount) return res.status(400).json({ error: 'Add at least one question before publishing.' });

  await db.collection('questionnaires').updateOne({ _id: id }, { $set: { status: 'Published', updatedAt: new Date() } });
  const updated = await db.collection('questionnaires').findOne({ _id: id });
  return res.status(200).json({ questionnaire: toDetail(updated, new Date()) });
}

// First delivery only. Only persists the status/token/timestamp transition once the
// email has actually been sent successfully -- "record when the email was sent"
// should never be recorded for an email that failed to go out. See resend()/remind()
// for repeat deliveries.
async function send(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid questionnaire ID is required.' });

  const questionnaire = await db.collection('questionnaires').findOne({ _id: id });
  if (!questionnaire) return res.status(404).json({ error: 'Questionnaire not found.' });

  if (questionnaire.status !== 'Published') {
    return res.status(409).json({
      error: questionnaire.status === 'Draft'
        ? 'Publish this questionnaire before sending it.'
        : 'This questionnaire has already been sent. Use resend or a reminder instead.'
    });
  }

  let recipientEmail = clean(body.recipientEmail, 200).toLowerCase();
  if (!recipientEmail && questionnaire.clientId) {
    const client = await db.collection('clients').findOne({ _id: questionnaire.clientId });
    recipientEmail = client?.email || '';
  }
  if (!recipientEmail || !isValidEmail(recipientEmail)) {
    return res.status(400).json({ error: 'A valid recipient email is required.' });
  }

  const customMessage = clean(body.customMessage, 2000);
  const accessToken = questionnaire.accessToken || generateSecureToken();
  const tokenExpiresAt = resolveExpiresAt(body);

  const emailResult = await sendQuestionnaireInviteEmail(db, {
    questionnaire: { ...questionnaire, accessToken },
    recipientEmail,
    customMessage,
    type: 'initial_send'
  });
  if (!emailResult.success) return res.status(502).json({ error: emailResult.error });

  const now = new Date();
  await db.collection('questionnaires').updateOne({ _id: id }, { $set: {
    accessToken, tokenExpiresAt, recipientEmail,
    status: 'Sent', sentAt: now, lastEmailSentAt: now, updatedAt: now
  } });

  await advanceProjectDiscoveryStatus(db, questionnaire.projectId, 'Sent');

  const updated = await db.collection('questionnaires').findOne({ _id: id });
  return res.status(200).json({ questionnaire: toDetail(updated, now) });
}

// Shared by resend() and remind() -- identical mechanics, different email copy/type.
async function sendFollowUp(req, res, db, type) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid questionnaire ID is required.' });

  const questionnaire = await db.collection('questionnaires').findOne({ _id: id });
  if (!questionnaire) return res.status(404).json({ error: 'Questionnaire not found.' });
  if (!questionnaire.sentAt) return res.status(409).json({ error: 'This questionnaire has not been sent yet.' });
  if (['Completed', 'Archived'].includes(questionnaire.status)) {
    return res.status(409).json({ error: `This questionnaire is already ${questionnaire.status.toLowerCase()}.` });
  }

  const recipientEmail = clean(body.recipientEmail, 200).toLowerCase() || questionnaire.recipientEmail;
  if (!recipientEmail || !isValidEmail(recipientEmail)) return res.status(400).json({ error: 'A valid recipient email is required.' });

  const customMessage = clean(body.customMessage, 2000);
  const emailResult = await sendQuestionnaireInviteEmail(db, { questionnaire, recipientEmail, customMessage, type });
  if (!emailResult.success) return res.status(502).json({ error: emailResult.error });

  const now = new Date();
  await db.collection('questionnaires').updateOne({ _id: id }, { $set: {
    recipientEmail,
    lastEmailSentAt: now,
    tokenExpiresAt: resolveExpiresAt(body),
    updatedAt: now
  }, $inc: { reminderCount: 1 } });

  const updated = await db.collection('questionnaires').findOne({ _id: id });
  return res.status(200).json({ questionnaire: toDetail(updated, now) });
}

async function archive(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid questionnaire ID is required.' });

  const result = await db.collection('questionnaires').findOneAndUpdate(
    { _id: id },
    { $set: { status: 'Archived', archivedAt: new Date(), updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  const questionnaire = result?.value || result;
  if (!questionnaire) return res.status(404).json({ error: 'Questionnaire not found.' });
  return res.status(200).json({ questionnaire: toDetail(questionnaire, new Date()) });
}

// Creates a brand-new Draft instance from an existing questionnaire's *current*
// content (works whether the source came from a template or was built from
// scratch). Client/project/invoice attachments carry over by default; the admin can
// reassign them afterward via update. All response/delivery state resets.
async function duplicate(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid questionnaire ID is required.' });

  const existing = await db.collection('questionnaires').findOne({ _id: id });
  if (!existing) return res.status(404).json({ error: 'Questionnaire not found.' });

  const now = new Date();
  const document = {
    title: `${existing.title} (Copy)`,
    description: existing.description,
    sections: JSON.parse(JSON.stringify(existing.sections)),
    sourceTemplateId: existing.sourceTemplateId,
    sourceTemplateVersion: existing.sourceTemplateVersion,
    clientId: existing.clientId,
    projectId: existing.projectId,
    linkedInvoiceId: existing.linkedInvoiceId,
    status: 'Draft',
    accessToken: generateSecureToken(),
    tokenExpiresAt: null,
    recipientEmail: null,
    sentAt: null,
    lastEmailSentAt: null,
    reminderCount: 0,
    progress: { ...EMPTY_PROGRESS },
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  };

  const result = await db.collection('questionnaires').insertOne(document);
  return res.status(201).json({ questionnaire: toDetail({ ...document, _id: result.insertedId }, now) });
}

module.exports = async function handler(req, res) {
  try {
    const session = requireAdmin(req, res);
    if (!session) return;

    const db = await getDb();
    const route = action(req);

    if (route === 'dashboard') return dashboard(req, res, db);
    if (route === 'list') return list(req, res, db);
    if (route === 'get') return get(req, res, db);
    if (route === 'createfromtemplate') return createFromTemplate(req, res, db);
    if (route === 'createblank') return createBlank(req, res, db);
    if (route === 'update') return updateContent(req, res, db, false);
    if (route === 'savedraft') return updateContent(req, res, db, true);
    if (route === 'publish') return publish(req, res, db);
    if (route === 'send') return send(req, res, db);
    if (route === 'resend') return sendFollowUp(req, res, db, 'resend');
    if (route === 'remind') return sendFollowUp(req, res, db, 'reminder');
    if (route === 'archive') return archive(req, res, db);
    if (route === 'duplicate') return duplicate(req, res, db);
    return res.status(404).json({ error: 'Questionnaire action not found.' });
  } catch (error) {
    console.error('Questionnaires API error:', error);
    return res.status(500).json({ error: 'The request could not be completed.' });
  }
};
