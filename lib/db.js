require("../scripts/_env")();
const { MongoClient, ObjectId } = require('mongodb');

function getClientPromise() {
  if (!global._perlerMongoClientPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is missing.');
    global._perlerMongoClientPromise = new MongoClient(uri).connect();
  }
  return global._perlerMongoClientPromise;
}

async function getDb() {
  const client = await getClientPromise();
  return client.db(process.env.MONGODB_DB || 'perler');
}

function toObjectId(value) {
  return value && ObjectId.isValid(String(value)) ? new ObjectId(String(value)) : null;
}

function serialize(document) {
  if (!document) return document;
  const result = { ...document };
  if (result._id) {
    result._id = String(result._id);
    result.id = result._id;
  }
  return result;
}

module.exports = { getDb, toObjectId, serialize, ObjectId };
