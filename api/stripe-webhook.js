const { getDb, toObjectId } = require('../lib/db');
const stripe = require('../lib/stripe');

const HANDLED_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed'
]);

// Stripe signature verification needs the exact bytes as sent, so this reads the
// request stream directly instead of using lib/http.js's jsonBody(), which assumes
// (and would destroy) an already-parsed body.
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Returns true if this event should be (re)processed. A brand-new event id is
// recorded and processed immediately. A previously-seen event id is only reprocessed
// if it never finished successfully (e.g. the function crashed mid-update) — once a
// row is marked "processed" duplicate deliveries become a safe no-op.
async function claimEvent(db, event) {
  const events = db.collection('stripe_webhook_events');
  try {
    await events.insertOne({
      eventId: event.id,
      eventType: event.type,
      createdAt: new Date(),
      processedAt: null,
      status: 'received'
    });
    return true;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await events.findOne({ eventId: event.id });
    return existing?.status !== 'processed';
  }
}

async function markEventProcessed(db, eventId) {
  await db.collection('stripe_webhook_events').updateOne(
    { eventId },
    { $set: { processedAt: new Date(), status: 'processed' } }
  );
}

function paymentIntentIdFrom(session) {
  return typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id || null;
}

async function applyPaidInvoice(db, session) {
  const invoiceId = toObjectId(session.metadata?.invoiceId);
  if (!invoiceId) {
    console.error('Stripe webhook: session metadata is missing a valid invoiceId.');
    return;
  }

  const invoice = await db.collection('invoices').findOne({ _id: invoiceId });
  if (!invoice) {
    console.error(`Stripe webhook: no invoice found for id ${invoiceId}.`);
    return;
  }

  if (session.amount_total !== invoice.amount) {
    console.error(`Stripe webhook: amount mismatch for invoice ${invoiceId}.`);
    return;
  }
  if (session.currency !== invoice.currency) {
    console.error(`Stripe webhook: currency mismatch for invoice ${invoiceId}.`);
    return;
  }
  if (session.metadata?.invoiceNumber && session.metadata.invoiceNumber !== invoice.invoiceNumber) {
    console.error(`Stripe webhook: invoice number mismatch for invoice ${invoiceId}.`);
    return;
  }

  // The status filter makes this idempotent: once an invoice is Paid, replays of the
  // same (or a later) success event for it are no-ops.
  await db.collection('invoices').updateOne(
    { _id: invoiceId, status: { $ne: 'Paid' } },
    { $set: {
      status: 'Paid',
      paidAt: new Date(),
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentIdFrom(session),
      updatedAt: new Date()
    } }
  );
}

async function applyPaymentFailure(db, session) {
  const invoiceId = toObjectId(session.metadata?.invoiceId);
  if (!invoiceId) return;

  // A failed async payment attempt doesn't cancel the invoice — the client can still
  // retry. This just records the most recent failure for admin visibility.
  await db.collection('invoices').updateOne(
    { _id: invoiceId, status: { $ne: 'Paid' } },
    { $set: { paymentLastError: 'Async payment failed.', updatedAt: new Date() } }
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('Stripe webhook: STRIPE_WEBHOOK_SECRET is not configured.');
    return res.status(400).json({ error: 'Webhook is not configured.' });
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing Stripe signature.' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    console.error('Stripe webhook: failed to read request body:', error.message);
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error('Stripe webhook: signature verification failed:', error.message);
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    return res.status(200).json({ received: true });
  }

  try {
    const db = await getDb();

    const shouldProcess = await claimEvent(db, event);
    if (!shouldProcess) return res.status(200).json({ received: true, duplicate: true });

    const session = event.data.object;

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      if (session.mode === 'payment' && session.payment_status === 'paid') {
        await applyPaidInvoice(db, session);
      }
    } else if (event.type === 'checkout.session.async_payment_failed') {
      await applyPaymentFailure(db, session);
    }

    await markEventProcessed(db, event.id);
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Stripe webhook processing error:', error.message);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
};
