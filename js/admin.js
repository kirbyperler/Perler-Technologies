(() => {
  const views = document.querySelectorAll('.admin-view');
  const navLinks = document.querySelectorAll('.admin-nav a[data-route]');
  const logoutButton = document.getElementById('logout-button');

  const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const dateTimeFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  const formatMoney = cents => currencyFormatter.format(Number(cents || 0) / 100);
  const formatDate = value => (value ? dateFormatter.format(new Date(value)) : '—');
  const formatDateTime = value => (value ? dateTimeFormatter.format(new Date(value)) : '—');
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[char]));

  function statusBadge(status) {
    const key = String(status || '').toLowerCase();
    return `<span class="status-badge status-${key}">${escapeHtml(status)}</span>`;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options
    });

    if (response.status === 401) {
      window.location.href = '/admin-login';
      throw new Error('Session expired.');
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }

  async function copyToClipboard(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      document.body.removeChild(helper);
    }
    if (button) {
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = original; }, 1600);
    }
  }

  // ---------- Router ----------

  function currentRoute() {
    const hash = window.location.hash.replace(/^#\/?/, '');
    const parts = hash.split('/').filter(Boolean);
    if (parts[0] === 'invoices' && parts[1] === 'new') return { name: 'create' };
    if (parts[0] === 'invoices' && parts[1]) return { name: 'detail', id: parts[1] };
    if (parts[0] === 'invoices') return { name: 'invoices' };
    return { name: 'dashboard' };
  }

  function renderRoute() {
    const route = currentRoute();
    views.forEach(view => { view.hidden = view.dataset.view !== route.name; });
    navLinks.forEach(link => link.classList.toggle('active', link.dataset.route === route.name));

    document.querySelector('.admin-nav')?.classList.remove('open');
    document.querySelector('.menu-toggle')?.classList.remove('open');

    if (route.name === 'dashboard') loadDashboard();
    else if (route.name === 'invoices') loadInvoices();
    else if (route.name === 'create') resetCreateForm();
    else if (route.name === 'detail') loadInvoiceDetail(route.id);
  }

  window.addEventListener('hashchange', renderRoute);

  // ---------- Dashboard ----------

  async function loadDashboard() {
    const statsEl = document.getElementById('dashboard-stats');
    const recentEl = document.getElementById('dashboard-recent');
    statsEl.innerHTML = '<div class="state-message">Loading…</div>';
    recentEl.innerHTML = '';

    try {
      const data = await api('/api/invoices?action=dashboard');
      statsEl.innerHTML = `
        <div class="stat-card"><span>Total outstanding</span><strong>${formatMoney(data.totalOutstanding)}</strong></div>
        <div class="stat-card"><span>Paid</span><strong>${formatMoney(data.paidAmount)}</strong></div>
        <div class="stat-card"><span>Pending invoices</span><strong>${data.pendingCount}</strong></div>
        <div class="stat-card"><span>Overdue invoices</span><strong>${data.overdueCount}</strong></div>
      `;

      recentEl.innerHTML = data.recentInvoices.length
        ? renderInvoiceTable(data.recentInvoices)
        : '<div class="state-message">No invoices yet.</div>';
      bindTableActions(recentEl);
    } catch (error) {
      statsEl.innerHTML = `<div class="state-message is-error">${escapeHtml(error.message)}</div>`;
    }
  }

  // ---------- Invoices list ----------

  let searchDebounce = null;

  function renderInvoiceTable(invoices) {
    const rows = invoices.map(invoice => `
      <tr data-id="${invoice.id}">
        <td data-label="Invoice">${escapeHtml(invoice.invoiceNumber)}</td>
        <td data-label="Client">${escapeHtml(invoice.businessName || invoice.clientName)}</td>
        <td data-label="Project" class="cell-muted">${escapeHtml(invoice.projectName)}</td>
        <td data-label="Amount">${formatMoney(invoice.amount)}</td>
        <td data-label="Type" class="cell-muted">${escapeHtml(invoice.paymentType)}</td>
        <td data-label="Due">${formatDate(invoice.dueDate)}</td>
        <td data-label="Status">${statusBadge(invoice.status)}</td>
        <td data-label="Actions">
          <div class="row-actions">
            <a href="#/invoices/${invoice.id}">View</a>
            <button type="button" class="copy-link-button" data-id="${invoice.id}">Copy link</button>
          </div>
        </td>
      </tr>
    `).join('');

    return `
      <table class="invoice-table">
        <thead>
          <tr>
            <th>Invoice</th><th>Client</th><th>Project</th><th>Amount</th>
            <th>Type</th><th>Due</th><th>Status</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function bindTableActions(container) {
    container.querySelectorAll('.copy-link-button').forEach(button => {
      button.addEventListener('click', async () => {
        try {
          const data = await api(`/api/invoices?action=get&id=${encodeURIComponent(button.dataset.id)}`);
          await copyToClipboard(data.invoice.paymentLink, button);
        } catch {
          button.textContent = 'Failed';
          setTimeout(() => { button.textContent = 'Copy link'; }, 1600);
        }
      });
    });
  }

  async function loadInvoices() {
    const panel = document.getElementById('invoices-panel');
    panel.innerHTML = '<div class="state-message">Loading…</div>';

    const search = document.getElementById('invoice-search').value.trim();
    const status = document.getElementById('invoice-status-filter').value;
    const sort = document.getElementById('invoice-sort').value;

    const params = new URLSearchParams({ action: 'list', sort });
    if (search) params.set('search', search);
    if (status) params.set('status', status);

    try {
      const data = await api(`/api/invoices?${params.toString()}`);
      panel.innerHTML = data.invoices.length
        ? renderInvoiceTable(data.invoices)
        : '<div class="state-message">No invoices match your filters.</div>';
      bindTableActions(panel);
    } catch (error) {
      panel.innerHTML = `<div class="state-message is-error">${escapeHtml(error.message)}</div>`;
    }
  }

  document.getElementById('invoice-search')?.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadInvoices, 300);
  });
  document.getElementById('invoice-status-filter')?.addEventListener('change', loadInvoices);
  document.getElementById('invoice-sort')?.addEventListener('change', loadInvoices);

  // ---------- Create invoice ----------

  const createForm = document.getElementById('create-invoice-form');
  const createSuccess = document.getElementById('create-success');

  function resetCreateForm() {
    createForm.hidden = false;
    createSuccess.hidden = true;
    createForm.reset();
    createForm.querySelectorAll('.field-group').forEach(group => group.classList.remove('has-error'));
    createForm.querySelectorAll('.field-error').forEach(el => { el.textContent = ''; });
    document.getElementById('create-status').textContent = '';
  }

  function setFieldError(form, name, message = '') {
    const field = form.elements[name];
    const error = form.querySelector(`[data-error-for="${name}"]`);
    const group = field?.closest('.field-group');
    if (error) error.textContent = message;
    group?.classList.toggle('has-error', Boolean(message));
  }

  function validateCreateForm(form) {
    let valid = true;
    const fail = (name, message) => { setFieldError(form, name, message); valid = false; };

    ['clientName', 'businessName', 'projectName', 'description', 'amount', 'paymentType', 'dueDate', 'internalNotes']
      .forEach(name => setFieldError(form, name));

    if (!form.elements.clientName.value.trim()) fail('clientName', 'Client name is required.');
    const email = form.elements.clientEmail.value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('clientEmail', 'A valid email is required.');
    if (!form.elements.projectName.value.trim()) fail('projectName', 'Project name is required.');
    if (!form.elements.description.value.trim()) fail('description', 'Description is required.');

    const amountRaw = form.elements.amount.value.trim().replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(amountRaw) || Number(amountRaw) <= 0) {
      fail('amount', 'Enter a valid amount greater than zero (max 2 decimal places).');
    }

    if (!form.elements.paymentType.value) fail('paymentType', 'Select a payment type.');
    if (!form.elements.dueDate.value) fail('dueDate', 'Due date is required.');

    return valid;
  }

  let isSubmittingInvoice = false;

  createForm?.addEventListener('submit', async event => {
    event.preventDefault();
    if (isSubmittingInvoice) return;
    if (!validateCreateForm(createForm)) return;

    const submitButton = createForm.querySelector('.submit-button');
    const buttonLabel = submitButton.querySelector('.button-label');
    const statusEl = document.getElementById('create-status');
    statusEl.textContent = '';

    isSubmittingInvoice = true;
    submitButton.disabled = true;
    submitButton.classList.add('is-loading');
    buttonLabel.textContent = 'Creating';

    const payload = Object.fromEntries(new FormData(createForm).entries());

    try {
      const data = await api('/api/invoices?action=create', { method: 'POST', body: JSON.stringify(payload) });
      const invoice = data.invoice;

      document.getElementById('created-invoice-number').textContent = invoice.invoiceNumber;
      document.getElementById('created-invoice-summary').innerHTML = `
        ${escapeHtml(invoice.businessName || invoice.clientName)} — ${escapeHtml(invoice.projectName)}<br>
        ${formatMoney(invoice.amount)} · ${escapeHtml(invoice.paymentType)} · Due ${formatDate(invoice.dueDate)}
      `;
      document.getElementById('created-payment-link').value = invoice.paymentLink;
      document.getElementById('view-created-invoice').href = `#/invoices/${invoice.id}`;

      createForm.hidden = true;
      createSuccess.hidden = false;
    } catch (error) {
      statusEl.textContent = error.message;
    } finally {
      isSubmittingInvoice = false;
      submitButton.disabled = false;
      submitButton.classList.remove('is-loading');
      buttonLabel.textContent = 'Create invoice';
    }
  });

  document.getElementById('copy-created-link')?.addEventListener('click', event => {
    copyToClipboard(document.getElementById('created-payment-link').value, event.currentTarget);
  });

  // The link points at #/invoices/new, which may already be the current hash (no
  // hashchange event would fire), so reset explicitly instead of relying on the router.
  document.getElementById('create-another')?.addEventListener('click', event => {
    event.preventDefault();
    resetCreateForm();
  });

  // ---------- Invoice detail ----------

  async function loadInvoiceDetail(id) {
    const panel = document.getElementById('invoice-detail-panel');
    panel.innerHTML = '<div class="state-message">Loading…</div>';

    try {
      const data = await api(`/api/invoices?action=get&id=${encodeURIComponent(id)}`);
      const invoice = data.invoice;

      panel.innerHTML = `
        <div class="panel-heading">
          <h2>${escapeHtml(invoice.invoiceNumber)}</h2>
          ${statusBadge(invoice.status)}
        </div>
        <div class="detail-grid">
          <div class="detail-field"><span>Client name</span><p>${escapeHtml(invoice.clientName)}</p></div>
          <div class="detail-field"><span>Client email</span><p>${escapeHtml(invoice.clientEmail)}</p></div>
          <div class="detail-field"><span>Business name</span><p>${escapeHtml(invoice.businessName || '—')}</p></div>
          <div class="detail-field"><span>Project name</span><p>${escapeHtml(invoice.projectName)}</p></div>
          <div class="detail-field"><span>Amount</span><p>${formatMoney(invoice.amount)}</p></div>
          <div class="detail-field"><span>Payment type</span><p>${escapeHtml(invoice.paymentType)}</p></div>
          <div class="detail-field"><span>Due date</span><p>${formatDate(invoice.dueDate)}</p></div>
          <div class="detail-field"><span>Created</span><p>${formatDateTime(invoice.createdAt)}</p></div>
          <div class="detail-field"><span>Updated</span><p>${formatDateTime(invoice.updatedAt)}</p></div>
          ${invoice.paidAt ? `<div class="detail-field"><span>Paid</span><p>${formatDateTime(invoice.paidAt)}</p></div>` : ''}
          <div class="detail-field full-width"><span>Description</span><p>${escapeHtml(invoice.description)}</p></div>
          <div class="detail-field full-width"><span>Internal notes</span><p>${escapeHtml(invoice.internalNotes || '—')}</p></div>
        </div>
        <div class="payment-link-row">
          <input type="text" readonly aria-label="Private payment link" value="${escapeHtml(invoice.paymentLink)}" id="detail-payment-link">
          <button class="button button-secondary" type="button" id="detail-copy-link">Copy link</button>
        </div>
      `;

      document.getElementById('detail-copy-link')?.addEventListener('click', event => {
        copyToClipboard(invoice.paymentLink, event.currentTarget);
      });
    } catch (error) {
      panel.innerHTML = `<div class="state-message is-error">${escapeHtml(error.message)}</div>`;
    }
  }

  // ---------- Logout ----------

  logoutButton?.addEventListener('click', async () => {
    logoutButton.disabled = true;
    try {
      await fetch('/api/auth?action=logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      window.location.href = '/admin-login';
    }
  });

  // ---------- Boot ----------

  (async () => {
    try {
      await api('/api/auth?action=session');
      renderRoute();
    } catch {
      // api() already redirects to /admin-login on 401
    }
  })();
})();
