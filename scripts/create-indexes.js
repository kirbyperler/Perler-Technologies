require('./_env')();
const { MongoClient } = require('mongodb');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Add it to .env.local or your shell environment.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'perler');

  try {
    await db.collection('admins').createIndex({ email: 1 }, { unique: true });

    await db.collection('invoices').createIndex({ invoiceNumber: 1 }, { unique: true });
    await db.collection('invoices').createIndex({ paymentToken: 1 }, { unique: true });
    await db.collection('invoices').createIndex({ status: 1 });
    await db.collection('invoices').createIndex({ createdAt: -1 });
    await db.collection('invoices').createIndex({ dueDate: 1 });

    // Auto-expire stale login-attempt records; see lib/auth.js.
    await db.collection('login_attempts').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    // Stripe can retry webhook deliveries; this makes duplicate event ids safe to insert.
    await db.collection('stripe_webhook_events').createIndex({ eventId: 1 }, { unique: true });

    console.log('Indexes created successfully.');
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error('Failed to create indexes:', error.message);
  process.exit(1);
});
