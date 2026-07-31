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

    // Generic public-endpoint rate limiting; see lib/rateLimit.js.
    await db.collection('rate_limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    // ---------- Questionnaire system (Phase 2) ----------

    // email is intentionally NOT unique -- a shared business inbox may belong to more
    // than one client. Drop the old unique index from before this decision, if present,
    // then (re)create it as a plain lookup index. Safe to re-run.
    try {
      await db.collection('clients').dropIndex('email_1');
    } catch (error) {
      if (error?.codeName !== 'IndexNotFound') throw error;
    }
    await db.collection('clients').createIndex({ email: 1 });
    await db.collection('clients').createIndex({ createdAt: -1 });

    await db.collection('projects').createIndex({ clientId: 1 });
    await db.collection('projects').createIndex({ status: 1 });
    await db.collection('projects').createIndex({ createdAt: -1 });

    await db.collection('questionnaireTemplates').createIndex({ status: 1 });
    await db.collection('questionnaireTemplates').createIndex({ createdAt: -1 });

    await db.collection('questionnaires').createIndex({ accessToken: 1 }, { unique: true, sparse: true });
    await db.collection('questionnaires').createIndex({ status: 1 });
    await db.collection('questionnaires').createIndex({ clientId: 1 });
    await db.collection('questionnaires').createIndex({ projectId: 1 });
    await db.collection('questionnaires').createIndex({ linkedInvoiceId: 1 });
    await db.collection('questionnaires').createIndex({ sourceTemplateId: 1 });
    await db.collection('questionnaires').createIndex({ createdAt: -1 });

    // One response per questionnaire instance.
    await db.collection('questionnaireResponses').createIndex({ questionnaireId: 1 }, { unique: true });

    await db.collection('questionnaireFiles').createIndex({ questionnaireId: 1 });
    await db.collection('questionnaireFiles').createIndex({ questionId: 1 });

    await db.collection('questionnaireEmailLog').createIndex({ questionnaireId: 1 });
    await db.collection('questionnaireEmailLog').createIndex({ sentAt: -1 });

    console.log('Indexes created successfully.');
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error('Failed to create indexes:', error.message);
  process.exit(1);
});
