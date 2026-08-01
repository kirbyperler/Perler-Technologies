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

  // Strips anything that isn't a-z0-9 from the class key (not just lowercasing) so a
  // multi-word status like "On Hold" produces one valid class ("status-onhold")
  // instead of silently splitting into two class tokens on the space.
  function statusBadge(status) {
    const key = String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
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
    if (!response.ok) {
      const error = new Error(data.error || 'The request could not be completed.');
      if (Array.isArray(data.errors)) error.errors = data.errors; // e.g. questionnaire content validation
      throw error;
    }
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

    if (parts[0] === 'clients' && parts[1]) return { name: 'client-detail', id: parts[1] };
    if (parts[0] === 'clients') return { name: 'clients' };

    if (parts[0] === 'projects' && parts[1]) return { name: 'project-detail', id: parts[1] };
    if (parts[0] === 'projects') return { name: 'projects' };

    if (parts[0] === 'questionnaires' && parts[1] === 'builder') {
      return { name: 'questionnaire-builder', kind: parts[2], id: parts[3] };
    }
    if (parts[0] === 'questionnaires' && parts[1]) return { name: 'questionnaires-list', filter: parts[1] };
    if (parts[0] === 'questionnaires') return { name: 'questionnaires-overview' };

    return { name: 'dashboard' };
  }

  function renderRoute() {
    const route = currentRoute();
    views.forEach(view => { view.hidden = view.dataset.view !== route.name; });

    // Templates/drafts/pending/completed/archived all map onto the single
    // "Questionnaires" nav link, same as invoice detail mapping onto "Invoices".
    const navName = route.name === 'questionnaires-list' || route.name === 'questionnaire-builder'
      ? 'questionnaires-overview'
      : (route.name === 'detail' ? 'invoices' : route.name);
    navLinks.forEach(link => link.classList.toggle('active', link.dataset.route === navName));

    document.querySelector('.admin-nav')?.classList.remove('open');
    document.querySelector('.menu-toggle')?.classList.remove('open');

    if (route.name === 'dashboard') loadDashboard();
    else if (route.name === 'invoices') loadInvoices();
    else if (route.name === 'create') resetCreateForm();
    else if (route.name === 'detail') loadInvoiceDetail(route.id);
    else if (route.name === 'clients') window.loadClients?.();
    else if (route.name === 'client-detail') window.loadClientDetail?.(route.id);
    else if (route.name === 'projects') window.loadProjects?.();
    else if (route.name === 'project-detail') window.loadProjectDetail?.(route.id);
    else if (route.name === 'questionnaires-overview') window.loadQuestionnairesOverview?.();
    else if (route.name === 'questionnaires-list') window.loadQuestionnairesList?.(route.filter);
    else if (route.name === 'questionnaire-builder') window.loadQuestionnaireBuilder?.(route.kind, route.id);
  }

  // Blocks navigating away from the builder (via nav links, Back/Forward, or a
  // direct hash edit) while there are unsaved changes -- window.builderHasUnsavedChanges
  // is defined by js/questionnaire-builder.js.
  window.addEventListener('hashchange', function(event) {
    if (typeof window.builderHasUnsavedChanges === 'function' && window.builderHasUnsavedChanges()) {
      const proceed = window.confirm('You have unsaved changes in this questionnaire. Leave without saving?');
      if (!proceed) {
        const previousHash = new URL(event.oldURL).hash;
        window.location.hash = previousHash;
        return;
      }
    }
    renderRoute();
  });

  window.addEventListener('beforeunload', function(event) {
    if (typeof window.builderHasUnsavedChanges === 'function' && window.builderHasUnsavedChanges()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  // ---------- Generic modal (shared by every admin form/confirmation dialog) ----------
  // Traps Tab/Shift+Tab focus inside the panel while open and restores focus to
  // whatever triggered it on close, so keyboard/screen-reader users never land back
  // at the top of the page after closing a dialog.

  let modalOpenerElement = null;

  function focusableElements(container) {
    return Array.from(container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(el => el.offsetParent !== null);
  }

  function trapModalFocus(event) {
    if (event.key !== 'Tab') return;
    const panel = document.getElementById('modalPanel');
    const focusable = focusableElements(panel);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function openModalWithNode(title, nodeId, options = {}) {
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    const panel = document.getElementById('modalPanel');
    const node = document.getElementById(nodeId);
    if (!overlay || !titleEl || !bodyEl || !node) return;

    if (!node.__modalHome) node.__modalHome = { parent: node.parentElement, next: node.nextSibling };
    bodyEl.innerHTML = '';
    bodyEl.appendChild(node);
    node.classList.remove('hidden');

    titleEl.textContent = title;
    panel?.classList.toggle('modal-wide', Boolean(options.wide));
    overlay.classList.add('open');
    document.body.classList.add('modal-open');

    modalOpenerElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusableElements(panel)[0]?.focus();
  }

  function closeModal() {
    const overlay = document.getElementById('modalOverlay');
    const bodyEl = document.getElementById('modalBody');
    if (!overlay || !bodyEl) return;
    const node = bodyEl.firstElementChild;
    if (node && node.__modalHome) {
      node.classList.add('hidden');
      node.__modalHome.parent.insertBefore(node, node.__modalHome.next);
    }
    overlay.classList.remove('open');
    document.body.classList.remove('modal-open');

    const returnTo = modalOpenerElement && document.contains(modalOpenerElement) ? modalOpenerElement : null;
    modalOpenerElement = null;
    returnTo?.focus();
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeModal();
    else if (document.body.classList.contains('modal-open')) trapModalFocus(event);
  });

  // Reusable destructive-action confirmation, used throughout the admin instead of a
  // native confirm() so every destructive action shares one dialog.
  function requestConfirmation(message, onConfirm, confirmLabel = 'Confirm') {
    const messageEl = document.getElementById('confirm-action-message');
    const button = document.getElementById('confirm-action-button');
    if (messageEl) messageEl.textContent = message;
    if (button) {
      button.textContent = confirmLabel;
      button.onclick = async () => {
        button.disabled = true;
        try { await onConfirm(); } finally { button.disabled = false; }
      };
    }
    openModalWithNode('Confirm', 'confirm-action-card');
  }

  // ---------- Toast notifications ----------
  // Replaces alert()-style error/success reporting with one consistent, non-blocking
  // notification. type: 'success' (default) or 'error'. Destructive actions still go
  // through requestConfirmation() above before the request is made -- this is only
  // for reporting the outcome afterward.
  let toastCount = 0;

  function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container || !message) return;
    const isError = type === 'error';
    const toastEl = document.createElement('div');
    toastEl.id = `toast-${++toastCount}`;
    toastEl.className = `toast toast-${isError ? 'error' : 'success'}`;
    toastEl.setAttribute('role', isError ? 'alert' : 'status');
    toastEl.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    toastEl.textContent = message;
    container.appendChild(toastEl);
    requestAnimationFrame(() => toastEl.classList.add('toast-visible'));
    setTimeout(() => {
      toastEl.classList.remove('toast-visible');
      setTimeout(() => toastEl.remove(), 220);
    }, 4200);
  }

  // Trailing-edge debounce used by every search input across the admin (invoices,
  // clients, projects, questionnaires).
  function debounced(fn, ms = 300) {
    let handle = null;
    return (...args) => { clearTimeout(handle); handle = setTimeout(() => fn(...args), ms); };
  }

  const formatDuration = seconds => {
    if (seconds == null) return '—';
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  };

  // Single namespace for everything the questionnaire/client/project modules need
  // from this file, instead of a long list of individual window.* globals. Page-level
  // action handlers (open*Form, save*, etc. in the other admin-* files) still need to
  // stay directly on window because they're wired via inline onclick="" attributes in
  // admin.html and in dynamically generated table/card markup, where only a bare
  // global name resolves -- see js/admin-questionnaires.js and
  // js/questionnaire-builder.js for how they register themselves.
  window.PerlerAdmin = {
    api,
    ui: { openModal: openModalWithNode, closeModal, confirm: requestConfirmation, toast: showToast },
    format: { money: formatMoney, date: formatDate, dateTime: formatDateTime, duration: formatDuration, escapeHtml, statusBadge },
    dom: { debounced, copyToClipboard }
  };

  // admin.html's modal close ("x") button calls closeModal() directly as a bare
  // global (inline onclick="" runs in global scope, not inside this IIFE), so it
  // needs a real window.closeModal in addition to PerlerAdmin.ui.closeModal -- this
  // was missing after the namespace consolidation, which silently broke every
  // modal's close button (including Preview's).
  window.closeModal = closeModal;

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
            <button type="button" class="edit-invoice-button" data-id="${invoice.id}">Edit</button>
            <button type="button" class="delete-invoice-button" data-id="${invoice.id}">Delete</button>
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
    container.querySelectorAll('.edit-invoice-button').forEach(button => {
      button.addEventListener('click', () => openEditInvoiceForm(button.dataset.id, button));
    });
    container.querySelectorAll('.delete-invoice-button').forEach(button => {
      button.addEventListener('click', () => confirmDeleteInvoice(button.dataset.id));
    });
  }

  // Whichever invoice view is currently on screen (list, detail, or the dashboard's
  // "Recent invoices" table) re-fetches its own data after an edit/delete -- nothing
  // is cached client-side, so this is always a fresh read from the database.
  function refreshInvoiceViews() {
    const route = currentRoute();
    if (route.name === 'invoices') loadInvoices();
    else if (route.name === 'detail') loadInvoiceDetail(route.id);
    else if (route.name === 'dashboard') loadDashboard();
  }

  // Shared by both the invoice-table row action and the detail view's Edit button.
  // Fetches the full invoice first (the list/table rows only carry a trimmed
  // projection) so the modal always opens already populated, instead of flashing an
  // empty form and filling in a beat later.
  async function openEditInvoiceForm(id, buttonEl) {
    const originalLabel = buttonEl?.textContent;
    if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = 'Loading…'; }

    try {
      const data = await api(`/api/invoices?action=get&id=${encodeURIComponent(id)}`);
      const invoice = data.invoice;

      const form = document.getElementById('edit-invoice-form');
      form.reset();
      form.querySelectorAll('.field-group').forEach(group => group.classList.remove('has-error'));
      form.querySelectorAll('.field-error').forEach(el => { el.textContent = ''; });
      document.getElementById('edit-invoice-form-status').textContent = '';

      form.elements.id.value = invoice.id;
      form.elements.clientName.value = invoice.clientName || '';
      form.elements.clientEmail.value = invoice.clientEmail || '';
      form.elements.businessName.value = invoice.businessName || '';
      form.elements.projectName.value = invoice.projectName || '';
      form.elements.description.value = invoice.description || '';
      form.elements.amount.value = (Number(invoice.amount || 0) / 100).toFixed(2);
      form.elements.paymentType.value = invoice.paymentType || '';
      form.elements.dueDate.value = invoice.dueDate ? new Date(invoice.dueDate).toISOString().slice(0, 10) : '';
      // "Overdue" is derived, never stored (see api/invoices.js effectiveStatus()) and
      // isn't one of the Status select's options -- it maps back to the invoice's real
      // stored status, Pending, so re-saving without touching Status is a no-op.
      form.elements.status.value = invoice.status === 'Overdue' ? 'Pending' : invoice.status;
      form.elements.internalNotes.value = invoice.internalNotes || '';

      openModalWithNode('Edit Invoice', 'edit-invoice-card');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = originalLabel; }
    }
  }

  let isSavingInvoiceEdit = false;

  window.submitEditInvoiceForm = async function submitEditInvoiceForm(event) {
    event.preventDefault();
    if (isSavingInvoiceEdit) return;

    const form = event.target;
    if (!validateCreateForm(form)) return;

    const statusEl = document.getElementById('edit-invoice-form-status');
    statusEl.textContent = '';
    const submitButton = document.getElementById('edit-invoice-submit');
    const originalLabel = submitButton.textContent;

    isSavingInvoiceEdit = true;
    submitButton.disabled = true;
    submitButton.textContent = 'Saving…';

    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      await api('/api/invoices?action=update', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      showToast('Invoice updated.');
      refreshInvoiceViews();
    } catch (error) {
      statusEl.textContent = error.message;
    } finally {
      isSavingInvoiceEdit = false;
      submitButton.disabled = false;
      submitButton.textContent = originalLabel;
    }
  };

  function confirmDeleteInvoice(id) {
    requestConfirmation('Delete this invoice? This cannot be undone.', async () => {
      try {
        await api('/api/invoices?action=delete', { method: 'POST', body: JSON.stringify({ id }) });
        closeModal();
        showToast('Invoice deleted.');
        const route = currentRoute();
        if (route.name === 'detail' && route.id === id) {
          // The detail view for this exact invoice no longer has anything to show --
          // hashchange's own handler re-renders into the list, so don't also call
          // refreshInvoiceViews() here (that would just double-load).
          window.location.hash = '#/invoices';
        } else {
          refreshInvoiceViews();
        }
      } catch (error) {
        showToast(error.message, 'error');
      }
    }, 'Delete');
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
          <div class="row-actions">
            ${statusBadge(invoice.status)}
            <button class="button button-secondary" type="button" id="detail-edit-invoice">Edit</button>
            <button class="button button-secondary" type="button" id="detail-delete-invoice">Delete</button>
          </div>
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
      document.getElementById('detail-edit-invoice')?.addEventListener('click', event => {
        openEditInvoiceForm(invoice.id, event.currentTarget);
      });
      document.getElementById('detail-delete-invoice')?.addEventListener('click', () => {
        confirmDeleteInvoice(invoice.id);
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
