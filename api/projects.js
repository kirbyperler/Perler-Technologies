const { getDb, toObjectId, serialize } = require('../lib/db');
const { allowMethods, action, escapeRegex, jsonBody } = require('../lib/http');
const { requireAdmin } = require('../lib/auth');
const { clean, PROJECT_STATUSES } = require('../lib/validation');
const { batchFetchByIds } = require('../lib/relations');

const SORT_OPTIONS = {
  newest: { createdAt: -1 },
  name: { name: 1 }
};

async function assertNoDependents(db, projectId) {
  const questionnaireCount = await db.collection('questionnaires').countDocuments({ projectId });
  if (questionnaireCount > 0) {
    return `This project has ${questionnaireCount} questionnaire${questionnaireCount === 1 ? '' : 's'} attached and cannot be deleted. Archive or reassign those questionnaires first.`;
  }
  return null;
}

async function list(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;

  const filter = {};
  const search = clean(req.query?.search, 100);
  if (search) {
    const pattern = escapeRegex(search);
    filter.$or = ['name', 'description'].map(field => ({ [field]: { $regex: pattern, $options: 'i' } }));
  }

  const clientId = toObjectId(req.query?.clientId);
  if (clientId) filter.clientId = clientId;

  const status = clean(req.query?.status, 30);
  if (status) filter.status = status;

  const discoveryStatus = clean(req.query?.discoveryStatus, 30);
  if (discoveryStatus) filter.discoveryStatus = discoveryStatus;

  const sortKey = clean(req.query?.sort, 30).toLowerCase();
  const sort = SORT_OPTIONS[sortKey] || SORT_OPTIONS.newest;

  const projects = await db.collection('projects').find(filter).sort(sort).limit(1000).toArray();

  const clientById = await batchFetchByIds(db, 'clients', projects.map(p => p.clientId), { name: 1, businessName: 1 });

  return res.status(200).json({
    projects: projects.map(project => ({
      ...serialize(project),
      clientName: clientById.get(String(project.clientId))?.name || null,
      clientBusinessName: clientById.get(String(project.clientId))?.businessName || null
    }))
  });
}

async function get(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;
  const id = toObjectId(req.query?.id);
  if (!id) return res.status(404).json({ error: 'Project not found.' });

  const project = await db.collection('projects').findOne({ _id: id });
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const client = project.clientId ? await db.collection('clients').findOne({ _id: project.clientId }) : null;

  // "When a questionnaire is connected to a project, display it inside that project's
  // admin detail view alongside the existing invoices and payments." -- gathered here
  // so the frontend never has to make three separate calls to render one project page.
  const [invoices, questionnaires] = await Promise.all([
    db.collection('invoices').find({ projectId: id }, { projection: { internalNotes: 0 } }).sort({ createdAt: -1 }).toArray(),
    db.collection('questionnaires').find({ projectId: id }).sort({ createdAt: -1 }).toArray()
  ]);

  return res.status(200).json({
    project: serialize(project),
    client: client ? serialize(client) : null,
    invoices: invoices.map(serialize),
    questionnaires: questionnaires.map(q => ({
      id: String(q._id),
      title: q.title,
      status: q.status,
      sentAt: q.sentAt,
      lastEmailSentAt: q.lastEmailSentAt,
      progress: q.progress
    }))
  });
}

async function create(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);

  const clientId = toObjectId(body.clientId);
  if (!clientId) return res.status(400).json({ error: 'A valid client is required.' });

  const client = await db.collection('clients').findOne({ _id: clientId });
  if (!client) return res.status(404).json({ error: 'Client not found.' });

  const name = clean(body.name, 200);
  if (!name) return res.status(400).json({ error: 'Project name is required.' });

  const description = clean(body.description, 4000);
  const status = clean(body.status, 30) || 'Active';
  if (!PROJECT_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid project status.' });

  const now = new Date();
  const document = {
    clientId,
    name,
    description,
    status,
    discoveryStatus: 'Not Started',
    createdAt: now,
    updatedAt: now
  };

  const result = await db.collection('projects').insertOne(document);
  return res.status(201).json({ project: serialize({ ...document, _id: result.insertedId }) });
}

async function update(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid project ID is required.' });

  const updates = { updatedAt: new Date() };

  if (Object.prototype.hasOwnProperty.call(body, 'clientId')) {
    const clientId = toObjectId(body.clientId);
    if (!clientId) return res.status(400).json({ error: 'A valid client is required.' });
    const client = await db.collection('clients').findOne({ _id: clientId });
    if (!client) return res.status(404).json({ error: 'Client not found.' });
    updates.clientId = clientId;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = clean(body.name, 200);
    if (!name) return res.status(400).json({ error: 'Project name is required.' });
    updates.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'description')) updates.description = clean(body.description, 4000);
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const status = clean(body.status, 30);
    if (!PROJECT_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid project status.' });
    updates.status = status;
  }
  // discoveryStatus is intentionally not editable here -- it is only ever set by the
  // questionnaire lifecycle (api/questionnaires.js), never by hand, so it stays an
  // honest reflection of actual questionnaire progress.
  if (Object.prototype.hasOwnProperty.call(body, 'discoveryStatus')) {
    return res.status(400).json({ error: 'Discovery status is managed automatically and cannot be set directly.' });
  }

  const result = await db.collection('projects').findOneAndUpdate({ _id: id }, { $set: updates }, { returnDocument: 'after' });
  const project = result?.value || result;
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  return res.status(200).json({ project: serialize(project) });
}

async function del(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid project ID is required.' });

  const conflict = await assertNoDependents(db, id);
  if (conflict) return res.status(409).json({ error: conflict });

  const result = await db.collection('projects').deleteOne({ _id: id });
  if (!result.deletedCount) return res.status(404).json({ error: 'Project not found.' });
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
    if (route === 'delete') return del(req, res, db);
    return res.status(404).json({ error: 'Project action not found.' });
  } catch (error) {
    console.error('Projects API error:', error);
    return res.status(500).json({ error: 'The request could not be completed.' });
  }
};
