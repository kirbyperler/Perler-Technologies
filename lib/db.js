require("../scripts/_env")();
const { MongoClient, ObjectId } = require('mongodb');

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is missing.');

let clientPromise = global._perlerMongoClientPromise;
if (!clientPromise) {
  clientPromise = new MongoClient(uri).connect();
  global._perlerMongoClientPromise = clientPromise;
}

async function getDb() {
  const client = await clientPromise;
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
