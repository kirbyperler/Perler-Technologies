const PAYMENT_TYPES = ['Deposit', 'Milestone', 'Final payment', 'Hosting', 'Maintenance', 'Other'];

// "Overdue" is never stored directly — the server derives it from dueDate + status.
// See invoices.js effectiveStatus(). "Paid" and "Cancelled" are set by later phases
// (Stripe webhook, manual cancellation), not by the create form.
const INVOICE_STATUSES = ['Draft', 'Pending', 'Paid', 'Overdue', 'Cancelled'];

const MAX_AMOUNT_CENTS = 50_000_000_00; // $50,000,000 sanity ceiling

// Every invoice is created with currency: 'usd' today (see api/invoices.js create()).
// This whitelist exists so the Stripe checkout path has an explicit, auditable check
// rather than trusting whatever string happens to be stored.
const ALLOWED_CURRENCIES = ['usd'];

function isAllowedCurrency(value) {
  return typeof value === 'string' && ALLOWED_CURRENCIES.includes(value);
}

function clean(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Accepts "1500", "1500.00", "1,500.00". Rejects negatives, more than 2 decimals,
// NaN/Infinity, and non-positive or unreasonably large amounts. Returns integer cents.
function parseAmountToCents(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const str = String(raw).trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(str)) return null;
  const value = Number(str);
  if (!Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_AMOUNT_CENTS) return null;
  return cents;
}

function parseDueDate(raw) {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatCentsAsDollars(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

// Requires 12+ characters and at least 3 of: lowercase, uppercase, digit, symbol.
function isStrongPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/];
  const matched = classes.filter(pattern => pattern.test(password)).length;
  return matched >= 3;
}

module.exports = {
  PAYMENT_TYPES,
  INVOICE_STATUSES,
  ALLOWED_CURRENCIES,
  clean,
  isValidEmail,
  isAllowedCurrency,
  parseAmountToCents,
  parseDueDate,
  formatCentsAsDollars,
  isStrongPassword
};
