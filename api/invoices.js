const crypto = require('crypto');
const { getDb, toObjectId, serialize } = require('../lib/db');
const { allowMethods, action, escapeRegex, jsonBody } = require('../lib/http');
const { requireAdmin } = require('../lib/auth');
const stripe = require('../lib/stripe');
const {
  PAYMENT_TYPES,
  clean,
  isValidEmail,
  isAllowedCurrency,
  parseAmountToCents,
  parseDueDate,
  formatCentsAsDollars
} = require('../lib/validation');

const SORT_OPTIONS = {
  newest: { createdAt: -1 },
  duedate: { dueDate: 1 },
  amount: { amount: -1 },
  invoicenumber: { invoiceNumber: -1 }
};

// "Overdue" is never stored — it is derived here from dueDate + status so the browser
// can never claim an invoice is overdue (or not) on its own.
function effectiveStatus(invoice, now) {
  if (invoice.status === 'Pending' && invoice.dueDate && new Date(invoice.dueDate) < now) return 'Overdue';
  return invoice.status;
}

function siteBase() {
  return (process.env.SITE_URL || 'https://perlertechnologies.com').replace(/\/$/, '');
}

function paymentLinkFor(token) {
  return `${siteBase()}/pay/${token}`;
}

// Matches the alphabet + length produced by generatePaymentToken() (32 random bytes,
// base64url-encoded = 43 chars). Bounded so an oversized value is rejected without
// ever reaching a regex/DB call, and non-string values (e.g. ?token[$gt]=) are
// rejected by the typeof check in publicGet before this even runs.
const PAYMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

// Fields a client is allowed to see for their own invoice. Built as an explicit
// whitelist (never a spread-and-delete of the full document) so a new internal field
// added to the schema later can't leak here by accident.
function toPublicInvoice(invoice, now) {
  return {
    invoiceNumber: invoice.invoiceNumber,
    clientName: invoice.clientName,
    businessName: invoice.businessName || '',
    projectName: invoice.projectName,
    description: invoice.description,
    amount: invoice.amount,
    currency: invoice.currency,
    paymentType: invoice.paymentType,
    status: effectiveStatus(invoice, now),
    dueDate: invoice.dueDate,
    createdAt: invoice.createdAt
  };
}

function toListItem(invoice, now) {
  return {
    id: String(invoice._id),
    invoiceNumber: invoice.invoiceNumber,
    clientName: invoice.clientName,
    businessName: invoice.businessName,
    projectName: invoice.projectName,
    amount: invoice.amount,
    currency: invoice.currency,
    paymentType: invoice.paymentType,
    status: effectiveStatus(invoice, now),
    dueDate: invoice.dueDate,
    createdAt: invoice.createdAt
  };
}

function toDetail(invoice, now) {
  return {
    ...serialize(invoice),
    status: effectiveStatus(invoice, now),
    paymentLink: paymentLinkFor(invoice.paymentToken)
  };
}

async function nextInvoiceNumber(db) {
  const year = new Date().getFullYear();
  const result = await db.collection('counters').findOneAndUpdate(
    { _id: `invoice-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = result?.value || result;
  return `PT-${year}-${String(doc.seq).padStart(3, '0')}`;
}

function generatePaymentToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function dashboard(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;
  const now = new Date();
  const invoices = await db.collection('invoices')
    .find({}, { projection: { internalNotes: 0 } })
    .sort({ createdAt: -1 })
    .limit(2000)
    .toArray();

  let totalOutstanding = 0;
  let paidAmount = 0;
  let pendingCount = 0;
  let overdueCount = 0;

  for (const invoice of invoices) {
    const status = effectiveStatus(invoice, now);
    if (invoice.status === 'Pending') totalOutstanding += invoice.amount;
    if (invoice.status === 'Paid') paidAmount += invoice.amount;
    if (status === 'Pending') pendingCount += 1;
    if (status === 'Overdue') overdueCount += 1;
  }

  return res.status(200).json({
    totalOutstanding,
    totalOutstandingDisplay: formatCentsAsDollars(totalOutstanding),
    paidAmount,
    paidAmountDisplay: formatCentsAsDollars(paidAmount),
    pendingCount,
    overdueCount,
    recentInvoices: invoices.slice(0, 5).map(invoice => toListItem(invoice, now))
  });
}

async function list(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;
  const now = new Date();

  const filter = {};
  const search = clean(req.query?.search, 100);
  if (search) {
    const pattern = escapeRegex(search);
    filter.$or = ['invoiceNumber', 'clientName', 'businessName', 'projectName']
      .map(field => ({ [field]: { $regex: pattern, $options: 'i' } }));
  }

  const sortKey = clean(req.query?.sort, 30).toLowerCase();
  const sort = SORT_OPTIONS[sortKey] || SORT_OPTIONS.newest;

  const invoices = await db.collection('invoices')
    .find(filter, { projection: { internalNotes: 0 } })
    .sort(sort)
    .limit(1000)
    .toArray();

  const statusFilter = clean(req.query?.status, 30);
  const items = invoices
    .map(invoice => toListItem(invoice, now))
    .filter(item => !statusFilter || item.status === statusFilter);

  return res.status(200).json({ invoices: items });
}

async function get(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;
  const id = toObjectId(req.query?.id);
  if (!id) return res.status(404).json({ error: 'Invoice not found.' });

  const invoice = await db.collection('invoices').findOne({ _id: id });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });

  return res.status(200).json({ invoice: toDetail(invoice, new Date()) });
}

async function create(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  const body = jsonBody(req);

  const clientName = clean(body.clientName, 200);
  const clientEmail = clean(body.clientEmail, 200).toLowerCase();
  const businessName = clean(body.businessName, 200);
  const projectName = clean(body.projectName, 200);
  const description = clean(body.description, 2000);
  const paymentType = clean(body.paymentType, 60);
  const internalNotes = clean(body.internalNotes, 5000);

  if (!clientName) return res.status(400).json({ error: 'Client name is required.' });
  if (!clientEmail || !isValidEmail(clientEmail)) return res.status(400).json({ error: 'A valid client email is required.' });
  if (!projectName) return res.status(400).json({ error: 'Project name is required.' });
  if (!description) return res.status(400).json({ error: 'Description is required.' });
  if (!PAYMENT_TYPES.includes(paymentType)) return res.status(400).json({ error: 'Please select a valid payment type.' });

  const amount = parseAmountToCents(body.amount);
  if (!amount) return res.status(400).json({ error: 'Amount must be a valid dollar value greater than zero.' });

  const dueDate = parseDueDate(body.dueDate);
  if (!dueDate) return res.status(400).json({ error: 'A valid due date is required.' });

  // Optional links into the new clients/projects collections (see api/clients.js,
  // api/projects.js). Entirely additive: clientName/businessName/projectName above
  // remain required and are still what every existing invoice relies on -- these are
  // just an optional relational anchor for newly created invoices going forward.
  let clientId = null;
  let projectId = null;
  if (body.clientId) {
    clientId = toObjectId(body.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client reference.' });
    const clientDoc = await db.collection('clients').findOne({ _id: clientId });
    if (!clientDoc) return res.status(404).json({ error: 'Client not found.' });
  }
  if (body.projectId) {
    projectId = toObjectId(body.projectId);
    if (!projectId) return res.status(400).json({ error: 'Invalid project reference.' });
    const projectDoc = await db.collection('projects').findOne({ _id: projectId });
    if (!projectDoc) return res.status(404).json({ error: 'Project not found.' });
    clientId = projectDoc.clientId; // a project always determines its client
  }

  const now = new Date();
  const invoiceNumber = await nextInvoiceNumber(db);

  const document = {
    invoiceNumber,
    clientName,
    clientEmail,
    businessName,
    projectName,
    clientId,
    projectId,
    description,
    amount,
    currency: 'usd',
    paymentType,
    status: 'Pending',
    dueDate,
    internalNotes,
    paymentToken: generatePaymentToken(),
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    paidAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now
  };

  let inserted = null;
  for (let attempt = 0; attempt < 3 && !inserted; attempt += 1) {
    try {
      const result = await db.collection('invoices').insertOne(document);
      inserted = { ...document, _id: result.insertedId };
    } catch (error) {
      if (error?.code === 11000 && attempt < 2) {
        document.paymentToken = generatePaymentToken();
        continue;
      }
      throw error;
    }
  }

  return res.status(201).json({ invoice: toDetail(inserted, now) });
}

// Reuses an existing Checkout Session for this invoice if Stripe still considers it
// open and it was created for this exact invoice. Returns null if there's nothing
// reusable, in which case the caller should create a fresh session.
async function findReusableSession(invoice) {
  if (!invoice.stripeCheckoutSessionId) return null;

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(invoice.stripeCheckoutSessionId);
  } catch {
    return null; // session no longer exists or Stripe couldn't be reached — fall through to create a new one
  }

  const belongsToInvoice = session.metadata?.invoiceId === String(invoice._id);
  if (session.status === 'open' && session.url && belongsToInvoice) return session;
  return null;
}

// Public, unauthenticated: creates (or reuses) a Stripe Checkout Session for an
// invoice identified only by its private payment token. The amount, currency,
// description, and every other line-item detail come from MongoDB — nothing from the
// request body feeds into what Stripe is told to charge.
async function createCheckout(req, res, db) {
  if (!allowMethods(req, res, ['POST'])) return;
  res.setHeader('Cache-Control', 'no-store');

  const body = jsonBody(req);
  const rawToken = body.token;
  if (typeof rawToken !== 'string') return res.status(404).json({ error: 'Invoice not found.' });

  const token = rawToken.trim();
  if (!PAYMENT_TOKEN_PATTERN.test(token)) return res.status(404).json({ error: 'Invoice not found.' });

  const invoice = await db.collection('invoices').findOne({ paymentToken: token });
  if (!invoice || invoice.status === 'Draft') return res.status(404).json({ error: 'Invoice not found.' });

  if (invoice.status === 'Paid') return res.status(409).json({ error: 'This invoice has already been paid.' });
  if (invoice.status === 'Cancelled') return res.status(409).json({ error: 'This invoice has been cancelled and is no longer payable.' });

  const status = effectiveStatus(invoice, new Date());
  if (status !== 'Pending' && status !== 'Overdue') {
    return res.status(409).json({ error: 'This invoice is not currently payable.' });
  }

  if (!Number.isSafeInteger(invoice.amount) || invoice.amount <= 0) {
    console.error(`Checkout blocked: invoice ${invoice._id} has an invalid stored amount.`);
    return res.status(500).json({ error: 'This invoice could not be processed. Please contact Perler Technologies.' });
  }
  if (!isAllowedCurrency(invoice.currency)) {
    console.error(`Checkout blocked: invoice ${invoice._id} has an unsupported currency.`);
    return res.status(500).json({ error: 'This invoice could not be processed. Please contact Perler Technologies.' });
  }

  try {
    const reusable = await findReusableSession(invoice);
    if (reusable) return res.status(200).json({ checkoutUrl: reusable.url });

    // Atomically bump a per-invoice attempt counter so the Stripe idempotency key is
    // stable for retries of *this* attempt but distinct from any prior attempt (e.g. an
    // earlier session that expired). Never derived from the payment token itself.
    const counterResult = await db.collection('invoices').findOneAndUpdate(
      { _id: invoice._id },
      { $inc: { stripeSessionAttempt: 1 } },
      { returnDocument: 'after' }
    );
    const counterDoc = counterResult?.value || counterResult;
    const idempotencyKey = `checkout-${invoice._id}-v${counterDoc.stripeSessionAttempt}`;

    const base = siteBase();
    const successUrl = `${base}/pay/${invoice.paymentToken}?payment=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${base}/pay/${invoice.paymentToken}?payment=cancelled`;

    const metadata = { invoiceId: String(invoice._id), invoiceNumber: invoice.invoiceNumber };

    const sessionParams = {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: invoice.currency,
          unit_amount: invoice.amount,
          product_data: {
            name: `Invoice ${invoice.invoiceNumber}`,
            description: (invoice.projectName || invoice.description || 'Perler Technologies services').slice(0, 500)
          }
        },
        quantity: 1
      }],
      metadata,
      payment_intent_data: { metadata },
      success_url: successUrl,
      cancel_url: cancelUrl
    };
    if (isValidEmail(invoice.clientEmail)) sessionParams.customer_email = invoice.clientEmail;

    const session = await stripe.checkout.sessions.create(sessionParams, { idempotencyKey });

    await db.collection('invoices').updateOne(
      { _id: invoice._id },
      { $set: {
        stripeCheckoutSessionId: session.id,
        stripeCheckoutUrl: session.url,
        stripeSessionCreatedAt: new Date(),
        updatedAt: new Date()
      } }
    );

    return res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    console.error('Checkout session creation failed:', error.message);
    return res.status(502).json({ error: 'Payment setup is temporarily unavailable. Please try again shortly.' });
  }
}

// Public, unauthenticated: looks an invoice up by its private payment token only.
// No search, no listing, no lookup by invoice number, no write access — exact token
// match against a single collection field. See toPublicInvoice() for the response
// whitelist. Never mix this into the requireAdmin()-gated actions below.
async function publicGet(req, res, db) {
  if (!allowMethods(req, res, ['GET'])) return;
  res.setHeader('Cache-Control', 'no-store');

  const rawToken = req.query?.token;
  if (typeof rawToken !== 'string') return res.status(404).json({ error: 'Invoice not found.' });

  const token = rawToken.trim();
  if (!PAYMENT_TOKEN_PATTERN.test(token)) return res.status(404).json({ error: 'Invoice not found.' });

  const invoice = await db.collection('invoices').findOne(
    { paymentToken: token },
    { projection: {
      _id: 0, invoiceNumber: 1, clientName: 1, businessName: 1, projectName: 1,
      description: 1, amount: 1, currency: 1, paymentType: 1, status: 1, dueDate: 1, createdAt: 1
    } }
  );

  // A Draft invoice hasn't been sent to the client yet, so it isn't payable/visible publicly.
  if (!invoice || invoice.status === 'Draft') return res.status(404).json({ error: 'Invoice not found.' });

  return res.status(200).json({ invoice: toPublicInvoice(invoice, new Date()) });
}

module.exports = async function handler(req, res) {
  try {
    const db = await getDb();
    const route = action(req);

    if (route === 'public') return publicGet(req, res, db);
    if (route === 'createcheckout') return createCheckout(req, res, db);

    const session = requireAdmin(req, res);
    if (!session) return;

    if (route === 'dashboard') return dashboard(req, res, db);
    if (route === 'list') return list(req, res, db);
    if (route === 'get') return get(req, res, db);
    if (route === 'create') return create(req, res, db);
    return res.status(404).json({ error: 'Invoice action not found.' });
  } catch (error) {
    console.error('Invoices API error:', error);
    return res.status(500).json({ error: 'The request could not be completed.' });
  }
};
