// Shared helper for the "list of documents that each reference another collection by
// id, and the response needs a name/label from that referenced document" pattern --
// used by api/projects.js (client names) and api/questionnaires.js (client + project
// names). One query per referenced collection no matter how many rows are being
// rendered, instead of a query per row.
const { toObjectId } = require('./db');

async function batchFetchByIds(db, collectionName, idValues, projection) {
  const ids = [...new Set(idValues.map(String))].map(toObjectId).filter(Boolean);
  if (!ids.length) return new Map();
  const docs = await db.collection(collectionName).find({ _id: { $in: ids } }).project(projection).toArray();
  return new Map(docs.map(doc => [String(doc._id), doc]));
}

module.exports = { batchFetchByIds };
