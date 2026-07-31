const { getDb, toObjectId, serialize } = require('../lib/db');
const { allowMethods, action, escapeRegex, jsonBody } = require('../lib/http');
const { requireAdmin } = require('../lib/auth');
const { clean } = require('../lib/validation');
const { sanitizeQuestionnaireContent, TEMPLATE_STATUSES } = require('../lib/questionnaire-validation');

const SORT_OPTIONS = {
  newest: { createdAt: -1 },
  title: { title: 1 }
};

function toListItem(template) {
  return {
    id: String(template._id),
    title: template.title,
    description: template.description,
    status: template.status,
    version: template.version,
    sectionCount: (template.sections || []).length,
    questionCount: (template.sections || []).reduce((sum, section) => sum + (section.questions || []).length, 0),
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
  };
}

async function list(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;

  const filter = {};
  const search = clean(req.query?.search, 100);
  if (search) filter.title = { $regex: escapeRegex(search), $options: 'i' };

  const status = clean(req.query?.status, 30);
  if (status) filter.status = status;

  const sortKey = clean(req.query?.sort, 30).toLowerCase();
  const sort = SORT_OPTIONS[sortKey] || SORT_OPTIONS.newest;

  const templates = await db.collection('questionnaireTemplates').find(filter).sort(sort).limit(500).toArray();
  return res.status(200).json({ templates: templates.map(toListItem) });
}

async function get(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;
  const id = toObjectId(req.query?.id);
  if (!id) return res.status(404).json({ error: 'Template not found.' });

  const template = await db.collection('questionnaireTemplates').findOne({ _id: id });
  if (!template) return res.status(404).json({ error: 'Template not found.' });

  return res.status(200).json({ template: serialize(template) });
}

async function create(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);

  const { errors, title, description, sections } = sanitizeQuestionnaireContent(body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const now = new Date();
  const document = {
    title, description, sections,
    status: 'Draft',
    version: 1,
    createdAt: now,
    updatedAt: now
  };

  const result = await db.collection('questionnaireTemplates').insertOne(document);
  return res.status(201).json({ template: serialize({ ...document, _id: result.insertedId }) });
}

async function update(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid template ID is required.' });

  const existing = await db.collection('questionnaireTemplates').findOne({ _id: id });
  if (!existing) return res.status(404).json({ error: 'Template not found.' });

  const { errors, title, description, sections } = sanitizeQuestionnaireContent(body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const updates = {
    title, description, sections,
    version: (existing.version || 1) + 1,
    updatedAt: new Date()
  };

  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const status = clean(body.status, 30);
    if (!TEMPLATE_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid template status.' });
    updates.status = status;
  }

  await db.collection('questionnaireTemplates').updateOne({ _id: id }, { $set: updates });
  const updated = await db.collection('questionnaireTemplates').findOne({ _id: id });
  return res.status(200).json({ template: serialize(updated) });
}

// Duplicates a template's full content into a brand-new, independent template
// document (fresh id, Draft status, version reset to 1). Question/option ids are
// preserved as-is -- they only ever need to be unique *within* one document's own
// sections array (conditional logic always resolves against the same document), so
// there's no reason to regenerate them on copy.
async function duplicate(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid template ID is required.' });

  const existing = await db.collection('questionnaireTemplates').findOne({ _id: id });
  if (!existing) return res.status(404).json({ error: 'Template not found.' });

  const now = new Date();
  const document = {
    title: `${existing.title} (Copy)`,
    description: existing.description,
    sections: existing.sections,
    status: 'Draft',
    version: 1,
    createdAt: now,
    updatedAt: now
  };

  const result = await db.collection('questionnaireTemplates').insertOne(document);
  return res.status(201).json({ template: serialize({ ...document, _id: result.insertedId }) });
}

async function archive(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid template ID is required.' });

  const result = await db.collection('questionnaireTemplates').findOneAndUpdate(
    { _id: id },
    { $set: { status: 'Archived', updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  const template = result?.value || result;
  if (!template) return res.status(404).json({ error: 'Template not found.' });
  return res.status(200).json({ template: serialize(template) });
}

// Deleting a template never touches questionnaires already generated from it -- each
// instance holds its own deep-copied snapshot (see api/questionnaires.js
// createFromTemplate) and only keeps sourceTemplateId as a traceability breadcrumb, not
// a functional dependency. A dangling sourceTemplateId after deletion is expected and
// harmless.
async function del(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid template ID is required.' });

  const result = await db.collection('questionnaireTemplates').deleteOne({ _id: id });
  if (!result.deletedCount) return res.status(404).json({ error: 'Template not found.' });
  return res.status(200).json({ success: true });
}

module.exports = async function handler(req, res) {
  try {
    const session = requireAdmin(req, res);
    if (!session) return;

    const db = await getDb();
    const route = action(req);

    if (route === 'list') return list(req, res, db);
    if (route === 'get') return get(req, res, db);
    if (route === 'create') return create(req, res, db);
    if (route === 'update') return update(req, res, db);
    if (route === 'duplicate') return duplicate(req, res, db);
    if (route === 'archive') return archive(req, res, db);
    if (route === 'delete') return del(req, res, db);
    return res.status(404).json({ error: 'Template action not found.' });
  } catch (error) {
    console.error('Questionnaire templates API error:', error);
    return res.status(500).json({ error: 'The request could not be completed.' });
  }
};
