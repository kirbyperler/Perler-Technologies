(() => {
  const states = {
    loading: document.getElementById('state-loading'),
    error: document.getElementById('state-error'),
    notfound: document.getElementById('state-notfound'),
    invoice: document.getElementById('state-invoice')
  };

  const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  const formatMoney = cents => currencyFormatter.format(Number(cents || 0) / 100);
  const formatDate = value => (value ? dateFormatter.format(new Date(value)) : '—');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const POLL_ATTEMPTS = 5;
  const POLL_DELAY_MS = 2500;

  let currentToken = null;

  function showState(name) {
    Object.entries(states).forEach(([key, el]) => { if (el) el.hidden = key !== name; });
  }

  // Reads only the single path segment after /pay/, rejecting anything that isn't the
  // plain token alphabet (blocks malformed percent-encoding, JSON-like payloads,
  // extra slashes, and unreasonably long values before any network request is made).
  function extractToken() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'pay' || !segments[1]) return null;

    let token;
    try {
      token = decodeURIComponent(segments[1]);
    } catch {
      return null;
    }

    if (!/^[A-Za-z0-9_-]{1,256}$/.test(token)) return null;
    return token;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function setBanner(kind, message) {
    const banner = document.getElementById('payment-banner');
    if (!banner) return;
    if (!kind) {
      banner.hidden = true;
      banner.textContent = '';
      return;
    }
    banner.hidden = false;
    banner.className = `payment-banner payment-banner-${kind}`;
    banner.textContent = message;
  }

  function validateCheckoutUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.hostname === 'checkout.stripe.com') return url.href;
    } catch {
      // fall through
    }
    return null;
  }

  async function startCheckout(button, statusEl) {
    if (!currentToken) return;
    button.disabled = true;
    statusEl.textContent = 'Redirecting to secure checkout…';

    try {
      const response = await fetch('/api/invoices?action=createCheckout', {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: currentToken })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to start checkout. Please try again.');

      const checkoutUrl = validateCheckoutUrl(data.checkoutUrl);
      if (!checkoutUrl) throw new Error('Received an unexpected response from the payment processor.');

      window.location.assign(checkoutUrl);
    } catch (error) {
      statusEl.textContent = error.message;
      button.disabled = false;
    }
  }

  function buildPaymentArea(status) {
    const container = document.getElementById('payment-area');
    container.replaceChildren();

    if (status === 'Paid') {
      const paid = document.createElement('p');
      paid.className = 'payment-note payment-note-success';
      paid.textContent = 'This invoice has been paid. Thank you!';
      container.appendChild(paid);
      return;
    }

    if (status === 'Cancelled') {
      const cancelled = document.createElement('p');
      cancelled.className = 'payment-note payment-note-muted';
      cancelled.textContent = 'This invoice is no longer available for payment.';
      container.appendChild(cancelled);
      return;
    }

    if (status === 'Overdue') {
      const overdue = document.createElement('p');
      overdue.className = 'payment-note payment-note-overdue';
      overdue.textContent = 'This invoice is past its due date.';
      container.appendChild(overdue);
    }

    const note = document.createElement('p');
    note.className = 'payment-note';
    note.textContent = 'Pay this invoice securely using Stripe Checkout.';
    container.appendChild(note);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-primary pay-button';
    button.textContent = 'Pay Securely';
    container.appendChild(button);

    const statusEl = document.createElement('p');
    statusEl.className = 'payment-status-note';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    container.appendChild(statusEl);

    button.addEventListener('click', () => startCheckout(button, statusEl));
  }

  function renderInvoice(invoice) {
    setText('invoice-heading', `Invoice ${invoice.invoiceNumber}`);

    const badge = document.getElementById('invoice-status-badge');
    badge.textContent = invoice.status;
    badge.className = `status-badge status-${String(invoice.status).toLowerCase()}`;

    setText('detail-client', invoice.clientName);
    setText('detail-project', invoice.projectName);
    setText('detail-description', invoice.description);
    setText('detail-payment-type', invoice.paymentType);

    const businessRow = document.getElementById('row-business');
    if (invoice.businessName) {
      businessRow.hidden = false;
      setText('detail-business', invoice.businessName);
    } else {
      businessRow.hidden = true;
    }

    setText('detail-amount', formatMoney(invoice.amount));
    setText('detail-due-date', formatDate(invoice.dueDate));
    setText('detail-created-date', formatDate(invoice.createdAt));

    buildPaymentArea(invoice.status);
    showState('invoice');
  }

  // Distinguishes "not found" from "network/server error" so the initial load can pick
  // the right empty state. { ok, invoice } | { ok: false, notFound } | { ok: false }
  async function fetchPublicInvoiceResult(token) {
    try {
      const response = await fetch(`/api/invoices?action=public&token=${encodeURIComponent(token)}`, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-store' }
      });
      if (response.status === 404) return { ok: false, notFound: true };
      if (!response.ok) return { ok: false };
      const data = await response.json();
      return data.invoice ? { ok: true, invoice: data.invoice } : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  // Used by the polling loop, where the not-found/network distinction doesn't matter —
  // a miss just means "try again next tick" until attempts run out.
  async function fetchPublicInvoice(token) {
    const result = await fetchPublicInvoiceResult(token);
    return result.ok ? result.invoice : null;
  }

  // The redirect back from Stripe is only a hint, never proof of payment — the actual
  // status still comes from the webhook-updated database record. This just re-polls
  // the public endpoint a bounded number of times so the page catches up once the
  // webhook has landed, instead of polling forever.
  async function pollUntilPaid() {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      await sleep(POLL_DELAY_MS);
      const invoice = await fetchPublicInvoice(currentToken);
      if (!invoice) continue;

      renderInvoice(invoice);
      if (invoice.status === 'Paid') {
        setBanner('success', 'Payment confirmed. Thank you!');
        return;
      }
    }
    setBanner('pending', 'We are still confirming your payment. This can take a moment — feel free to refresh this page shortly.');
  }

  function cleanPaymentQueryParam() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('payment') && !url.searchParams.has('session_id')) return;
    url.searchParams.delete('payment');
    url.searchParams.delete('session_id');
    window.history.replaceState(null, '', url.pathname);
  }

  async function loadInvoice() {
    const token = extractToken();
    if (!token) {
      showState('notfound');
      return;
    }
    currentToken = token;

    const paymentParam = new URLSearchParams(window.location.search).get('payment');
    cleanPaymentQueryParam();

    const result = await fetchPublicInvoiceResult(token);
    if (!result.ok) {
      showState(result.notFound ? 'notfound' : 'error');
      return;
    }

    const invoice = result.invoice;
    renderInvoice(invoice);

    if (paymentParam === 'success') {
      if (invoice.status === 'Paid') {
        setBanner('success', 'Payment confirmed. Thank you!');
      } else {
        setBanner('pending', 'Your payment was submitted. Confirming payment status…');
        pollUntilPaid();
      }
    } else if (paymentParam === 'cancelled') {
      setBanner('cancelled', 'Payment was cancelled. Your invoice has not been charged.');
    }
  }

  loadInvoice();
})();
