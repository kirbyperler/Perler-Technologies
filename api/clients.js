const { getDb, toObjectId, serialize } = require('../lib/db');
const { allowMethods, action, escapeRegex, jsonBody } = require('../lib/http');
const { requireAdmin } = require('../lib/auth');
const { clean, isValidEmail } = require('../lib/validation');

const SORT_OPTIONS = {
  newest: { createdAt: -1 },
  name: { name: 1 }
};

// A client with active project/questionnaire history should never be silently
// deleted -- see del() below. Mirrors the explicit-conflict pattern the project
// already uses elsewhere (e.g. invoice creation's duplicate-email handling).
async function assertNoDependents(db, clientId) {
  const projectCount = await db.collection('projects').countDocuments({ clientId });
  if (projectCount > 0) {
    return `This client has ${projectCount} project${projectCount === 1 ? '' : 's'} and cannot be deleted. Delete or reassign those projects first.`;
  }
  return null;
}

async function list(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;

  const filter = {};
  const search = clean(req.query?.search, 100);
  if (search) {
    const pattern = escapeRegex(search);
    filter.$or = ['name', 'email', 'businessName'].map(field => ({ [field]: { $regex: pattern, $options: 'i' } }));
  }

  const sortKey = clean(req.query?.sort, 30).toLowerCase();
  const sort = SORT_OPTIONS[sortKey] || SORT_OPTIONS.newest;

  const clients = await db.collection('clients').find(filter).sort(sort).limit(1000).toArray();

  // One grouped query instead of a per-client count query (avoids N+1 on the list view).
  const counts = await db.collection('projects').aggregate([
    { $match: { clientId: { $in: clients.map(c => c._id) } } },
    { $group: { _id: '$clientId', count: { $sum: 1 } } }
  ]).toArray();
  const countByClientId = new Map(counts.map(row => [String(row._id), row.count]));

  return res.status(200).json({
    clients: clients.map(clientDoc => ({
      ...serialize(clientDoc),
      projectCount: countByClientId.get(String(clientDoc._id)) || 0
    }))
  });
}

async function get(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;
  const id = toObjectId(req.query?.id);
  if (!id) return res.status(404).json({ error: 'Client not found.' });

  const clientDoc = await db.collection('clients').findOne({ _id: id });
  if (!clientDoc) return res.status(404).json({ error: 'Client not found.' });

  const [projects, invoices, questionnaires] = await Promise.all([
    db.collection('projects').find({ clientId: id }).sort({ createdAt: -1 }).toArray(),
    // Only invoices that were created with a clientId link (see api/invoices.js
    // create()) -- older invoices that only carry a free-text clientName are
    // intentionally not fuzzy-matched here.
    db.collection('invoices').find({ clientId: id }, { projection: { internalNotes: 0 } }).sort({ createdAt: -1 }).toArray(),
    db.collection('questionnaires').find({ clientId: id }).sort({ createdAt: -1 }).toArray()
  ]);

  return res.status(200).json({
    client: serialize(clientDoc),
    projects: projects.map(serialize),
    invoices: invoices.map(serialize),
    questionnaires: questionnaires.map(q => ({
      id: String(q._id), title: q.title, status: q.status, sentAt: q.sentAt, progress: q.progress
    }))
  });
}

async function create(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);

  const name = clean(body.name, 200);
  const email = clean(body.email, 200).toLowerCase();
  const phone = clean(body.phone, 50);
  const businessName = clean(body.businessName, 200);
  const notes = clean(body.notes, 5000);

  if (!name) return res.status(400).json({ error: 'Client name is required.' });
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });

  const now = new Date();
  // email is intentionally not unique -- a shared business inbox (e.g. info@company.com)
  // may legitimately belong to more than one client record. See scripts/create-indexes.js.
  const document = { name, email, phone, businessName, notes, createdAt: now, updatedAt: now };

  const result = await db.collection('clients').insertOne(document);
  return res.status(201).json({ client: serialize({ ...document, _id: result.insertedId }) });
}

async function update(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid client ID is required.' });

  const updates = { updatedAt: new Date() };
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = clean(body.name, 200);
    if (!name) return res.status(400).json({ error: 'Client name is required.' });
    updates.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'email')) {
    const email = clean(body.email, 200).toLowerCase();
    if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
    updates.email = email;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'phone')) updates.phone = clean(body.phone, 50);
  if (Object.prototype.hasOwnProperty.call(body, 'businessName')) updates.businessName = clean(body.businessName, 200);
  if (Object.prototype.hasOwnProperty.call(body, 'notes')) updates.notes = clean(body.notes, 5000);

  const result = await db.collection('clients').findOneAndUpdate({ _id: id }, { $set: updates }, { returnDocument: 'after' });
  const clientDoc = result?.value || result;
  if (!clientDoc) return res.status(404).json({ error: 'Client not found.' });
  return res.status(200).json({ client: serialize(clientDoc) });
}

async function del(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);
  const id = toObjectId(body.id);
  if (!id) return res.status(400).json({ error: 'A valid client ID is required.' });

  const conflict = await assertNoDependents(db, id);
  if (conflict) return res.status(409).json({ error: conflict });

  const result = await db.collection('clients').deleteOne({ _id: id });
  if (!result.deletedCount) return res.status(404).json({ error: 'Client not found.' });
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
    return res.status(404).json({ error: 'Client action not found.' });
  } catch (error) {
    console.error('Clients API error:', error);
    return res.status(500).json({ error: 'The request could not be completed.' });
  }
};
