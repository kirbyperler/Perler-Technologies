// Clients, Projects, and Questionnaires (overview + reusable list) admin pages.
// Everything shared (fetch wrapper, modal/toast/confirm, formatters) comes from the
// window.PerlerAdmin namespace built in js/admin.js.
(() => {
  const { api, ui, format, dom } = window.PerlerAdmin;
  const { escapeHtml, formatMoney, formatDate, statusBadge: badge } = format;
  const { openModal: openModalWithNode, closeModal, confirm: requestConfirmation, toast } = ui;
  const { copyToClipboard, debounced } = dom;

  // ============================================================
  // CLIENTS
  // ============================================================

  let clients = [];
  let currentClientId = null;

  function renderClientsTable(list) {
    if (!list.length) return '<div class="state-message">No clients yet. Add one to get started.</div>';
    const rows = list.map(c => `
      <tr data-id="${c.id}">
        <td data-label="Name">${escapeHtml(c.name)}</td>
        <td data-label="Email" class="cell-muted">${escapeHtml(c.email)}</td>
        <td data-label="Business" class="cell-muted">${escapeHtml(c.businessName || '—')}</td>
        <td data-label="Projects">${c.projectCount}</td>
        <td data-label="Actions">
          <div class="row-actions">
            <a href="#/clients/${c.id}">Open</a>
            <button type="button" onclick="openClientForm('${c.id}')">Edit</button>
          </div>
        </td>
      </tr>
    `).join('');
    return `<table class="invoice-table"><thead><tr><th>Name</th><th>Email</th><th>Business</th><th>Projects</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  async function loadClients() {
    const panel = document.getElementById('clients-panel');
    if (!panel) return;
    panel.innerHTML = '<div class="state-message">Loading…</div>';
    const search = document.getElementById('client-search')?.value.trim() || '';
    const sort = document.getElementById('client-sort')?.value || 'newest';
    try {
      const params = new URLSearchParams({ action: 'list', sort });
      if (search) params.set('search', search);
      const data = await api(`/api/clients?${params}`);
      clients = data.clients;
      panel.innerHTML = renderClientsTable(clients);
    } catch (error) {
      panel.innerHTML = `<div class="state-message is-error">${escapeHtml(error.message)}</div>`;
    }
  }

  document.getElementById('client-search')?.addEventListener('input', debounced(loadClients));
  document.getElementById('client-sort')?.addEventListener('change', loadClients);

  window.openClientForm = function openClientForm(id) {
    const form = document.getElementById('client-form');
    form.reset();
    document.getElementById('client-form-id').value = '';
    document.getElementById('client-form-status').textContent = '';
    if (id) {
      const client = clients.find(c => c.id === id);
      if (client) {
        document.getElementById('client-form-id').value = client.id;
        document.getElementById('client-name').value = client.name;
        document.getElementById('client-email').value = client.email;
        document.getElementById('client-phone').value = client.phone || '';
        document.getElementById('client-business').value = client.businessName || '';
        document.getElementById('client-notes').value = client.notes || '';
      }
    }
    openModalWithNode(id ? 'Edit Client' : 'Add Client', 'client-form-card');
  };

  window.submitClientForm = async function submitClientForm(event) {
    event.preventDefault();
    const statusEl = document.getElementById('client-form-status');
    statusEl.textContent = '';
    const id = document.getElementById('client-form-id').value;
    const payload = {
      name: document.getElementById('client-name').value.trim(),
      email: document.getElementById('client-email').value.trim(),
      phone: document.getElementById('client-phone').value.trim(),
      businessName: document.getElementById('client-business').value.trim(),
      notes: document.getElementById('client-notes').value.trim()
    };
    if (id) payload.id = id;
    try {
      await api(`/api/clients?action=${id ? 'update' : 'create'}`, { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      await loadClients();
      if (currentClientId) loadClientDetail(currentClientId);
      window.populateClientProjectSelects?.();
    } catch (error) {
      statusEl.textContent = error.message;
    }
  };

  window.deleteClient = function deleteClient(id) {
    requestConfirmation('Delete this client? This cannot be undone.', async () => {
      try {
        await api('/api/clients?action=delete', { method: 'POST', body: JSON.stringify({ id }) });
        closeModal();
        window.location.hash = '#/clients';
      } catch (error) {
        toast(error.message, 'error');
      }
    }, 'Delete');
  };

  async function loadClientDetail(id) {
    currentClientId = id;
    const panel = document.getElementById('client-detail-panel');
    panel.innerHTML = '<div class="state-message">Loading…</div>';
    try {
      const { client, projects, invoices, questionnaires } = await api(`/api/clients?action=get&id=${encodeURIComponent(id)}`);
      panel.innerHTML = `
        <div class="panel-heading">
          <h2>${escapeHtml(client.name)}</h2>
          <div class="row-actions">
            <button class="button button-secondary" type="button" onclick="openClientForm('${client.id}')">Edit</button>
            <button class="button button-secondary" type="button" onclick="deleteClient('${client.id}')">Delete</button>
          </div>
        </div>
        <div class="detail-grid">
          <div class="detail-field"><span>Email</span><p>${escapeHtml(client.email)}</p></div>
          <div class="detail-field"><span>Phone</span><p>${escapeHtml(client.phone || '—')}</p></div>
          <div class="detail-field"><span>Business Name</span><p>${escapeHtml(client.businessName || '—')}</p></div>
          <div class="detail-field full-width"><span>Notes</span><p>${escapeHtml(client.notes || '—')}</p></div>
        </div>
        <p class="section-label" style="margin-top:24px;">Projects (${projects.length})</p>
        ${projects.length
          ? projects.map(p => `<div class="preview-question"><a class="text-link" href="#/projects/${p.id}">${escapeHtml(p.name)}</a> ${badge(p.status)}</div>`).join('')
          : '<div class="state-message">No projects yet.</div>'}
        <p class="section-label" style="margin-top:24px;">Questionnaires (${questionnaires.length})</p>
        ${questionnaires.length
          ? questionnaires.map(q => `<div class="preview-question">${escapeHtml(q.title)} ${badge(q.status)}</div>`).join('')
          : '<div class="state-message">None yet.</div>'}
        <p class="section-label" style="margin-top:24px;">Invoices (${invoices.length})</p>
        ${invoices.length
          ? invoices.map(inv => `<div class="preview-question"><a class="text-link" href="#/invoices/${inv.id}">${escapeHtml(inv.invoiceNumber)}</a> ${formatMoney(inv.amount)} ${badge(inv.status)}</div>`).join('')
          : '<div class="state-message">No linked invoices. Invoices created before a client link existed are not shown here.</div>'}
      `;
    } catch (error) {
      panel.innerHTML = `<div class="state-message is-error">${escapeHtml(error.message)}</div>`;
    }
  }

  window.loadClients = loadClients;
  window.loadClientDetail = loadClientDetail;

  // ============================================================
  // PROJECTS
  // ============================================================

  let projects = [];
  let currentProjectId = null;

  function renderProjectsTable(list) {
    if (!list.length) return '<div class="state-message">No projects yet. Add one to get started.</div>';
    const rows = list.map(p => `
      <tr data-id="${p.id}">
        <td data-label="Project">${escapeHtml(p.name)}</td>
        <td data-label="Client" class="cell-muted">${escapeHtml(p.clientName || '—')}</td>
        <td data-label="Status">${badge(p.status)}</td>
        <td data-label="Discovery" class="cell-muted">${badge(p.discoveryStatus)}</td>
        <td data-label="Actions">
          <div class="row-actions">
            <a href="#/projects/${p.id}">Open</a>
            <button type="button" onclick="openProjectForm('${p.id}')">Edit</button>
          </div>
        </td>
      </tr>
    `).join('');
    return `<table class="invoice-table"><thead><tr><th>Project</th><th>Client</th><th>Status</th><th>Discovery</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  async function loadProjects() {
    const panel = document.getElementById('projects-panel');
    if (!panel) return;
    panel.innerHTML = '<div class="state-message">Loading…</div>';
    const search = document.getElementById('project-search')?.value.trim() || '';
    const status = document.getElementById('project-status-filter')?.value || '';
    const discoveryStatus = document.getElementById('project-discovery-filter')?.value || '';
    try {
      const params = new URLSearchParams({ action: 'list' });
      if (search) params.set('search', search);
      if (status) params.set('status', status);
      if (discoveryStatus) params.set('discoveryStatus', discoveryStatus);
      const data = await api(`/api/projects?${params}`);
      projects = data.projects;
      panel.innerHTML = renderProjectsTable(projects);
    } catch (error) {
      panel.innerHTML = `<div class="state-message is-error">${escapeHtml(error.message)}</div>`;
    }
  }

  document.getElementById('project-search')?.addEventListener('input', debounced(loadProjects));
  document.getElementById('project-status-filter')?.addEventListener('change', loadProjects);
  document.getElementById('project-discovery-filter')?.addEventListener('change', loadProjects);

  // Keeps the Project select on the project form, and the Client/Project selects on
  // the "create from template" modal, in sync with the current client/project lists.
  // Called after any client/project create/edit so a brand-new record is immediately
  // selectable without a page reload.
  window.populateClientProjectSelects = async function populateClientProjectSelects() {
    try {
      if (!clients.length) clients = (await api('/api/clients?action=list&sort=name')).clients;
      if (!projects.length) projects = (await api('/api/projects?action=list')).projects;
    } catch { /* selects just stay empty; forms still show their required-field errors */ }

    const clientOptions = clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    const projectClientSelect = document.getElementById('project-client');
    if (projectClientSelect) projectClientSelect.innerHTML = `<option value="" disabled selected>Select a client</option>${clientOptions}`;

    const cftClient = document.getElementById('cft-client');
    if (cftClient) cftClient.innerHTML = `<option value="">None</option>${clientOptions}`;

    const cftProject = document.getElementById('cft-project');
    if (cftProject) cftProject.innerHTML = `<option value="">None</option>${projects.map(p => `<option value="${p.id}" data-client-id="${p.clientId || ''}">${escapeHtml(p.name)}</option>`).join('')}`;
  };

  window.openProjectForm = async function openProjectForm(id) {
    await window.populateClientProjectSelects();
    const form = document.getElementById('project-form');
    form.reset();
    document.getElementById('project-form-id').value = '';
    document.getElementById('project-form-status').textContent = '';
    if (id) {
      const project = projects.find(p => p.id === id);
      if (project) {
        document.getElementById('project-form-id').value = project.id;
        document.getElementById('project-client').value = project.clientId || '';
        document.getElementById('project-name').value = project.name;
        document.getElementById('project-description').value = project.description || '';
        document.getElementById('project-status').value = project.status;
      }
    }
    openModalWithNode(id ? 'Edit Project' : 'Add Project', 'project-form-card');
  };

  window.submitProjectForm = async function submitProjectForm(event) {
    event.preventDefault();
    const statusEl = document.getElementById('project-form-status');
    statusEl.textContent = '';
    const id = document.getElementById('project-form-id').value;
    const payload = {
      clientId: document.getElementById('project-client').value,
      name: document.getElementById('project-name').value.trim(),
      description: document.getElementById('project-description').value.trim(),
      status: document.getElementById('project-status').value
    };
    if (id) payload.id = id;
    try {
      await api(`/api/projects?action=${id ? 'update' : 'create'}`, { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      await loadProjects();
      if (currentProjectId) loadProjectDetail(currentProjectId);
    } catch (error) {
      statusEl.textContent = error.message;
    }
  };

  window.deleteProject = function deleteProject(id) {
    requestConfirmation('Delete this project? This cannot be undone.', async () => {
      try {
        await api('/api/projects?action=delete', { method: 'POST', body: JSON.stringify({ id }) });
        closeModal();
        window.location.hash = '#/projects';
      } catch (error) {
        toast(error.message, 'error');
      }
    }, 'Delete');
  };

  async function loadProjectDetail(id) {
    currentProjectId = id;
    const panel = document.getElementById('project-detail-panel');
    panel.innerHTML = '<div class="state-message">Loading…</div>';
    try {
      const { project, client, invoices, questionnaires } = await api(`/api/projects?action=get&id=${encodeURIComponent(id)}`);
      panel.innerHTML = `
        <div class="panel-heading">
          <h2>${escapeHtml(project.name)}</h2>
          <div class="row-actions">
            <button class="button button-secondary" type="button" onclick="openProjectForm('${project.id}')">Edit</button>
            <button class="button button-secondary" type="button" onclick="deleteProject('${project.id}')">Delete</button>
          </div>
        </div>
        <div class="detail-grid">
          <div class="detail-field"><span>Client</span><p>${client ? `<a class="text-link" href="#/clients/${client.id}">${escapeHtml(client.name)}</a>` : '—'}</p></div>
          <div class="detail-field"><span>Status</span><p>${badge(project.status)}</p></div>
          <div class="detail-field"><span>Discovery Status</span><p>${badge(project.discoveryStatus)}</p></div>
          <div class="detail-field full-width"><span>Description</span><p>${escapeHtml(project.description || '—')}</p></div>
        </div>
        <div class="quick-actions" style="margin-top:20px;">
          <button class="button button-primary" type="button" onclick="startQuestionnaireForProject('${project.id}', '${client ? client.id : ''}')">New Questionnaire For This Project</button>
        </div>
        <p class="section-label" style="margin-top:12px;">Questionnaires (${questionnaires.length})</p>
        ${questionnaires.length
          ? `<table class="invoice-table"><thead><tr><th>Title</th><th>Status</th><th>Sent</th><th>Progress</th></tr></thead><tbody>${questionnaires.map(q => `
              <tr><td data-label="Title">${escapeHtml(q.title)}</td><td data-label="Status">${badge(q.status)}</td><td data-label="Sent" class="cell-muted">${formatDate(q.sentAt)}</td><td data-label="Progress" class="cell-muted">${(q.progress && q.progress.completionPercentage) || 0}%</td></tr>
            `).join('')}</tbody></table>`
          : '<div class="state-message">None yet.</div>'}
        <p class="section-label" style="margin-top:24px;">Invoices (${invoices.length})</p>
        ${invoices.length
          ? invoices.map(inv => `<div class="preview-question"><a class="text-link" href="#/invoices/${inv.id}">${escapeHtml(inv.invoiceNumber)}</a> ${formatMoney(inv.amount)} ${badge(inv.status)}</div>`).join('')
          : '<div class="state-message">No linked invoices. Invoices created before a project link existed are not shown here.</div>'}
      `;
    } catch (error) {
      panel.innerHTML = `<div class="state-message is-error">${escapeHtml(error.message)}</div>`;
    }
  }

  window.loadProjects = loadProjects;
  window.loadProjectDetail = loadProjectDetail;

  // Quick action from a project's detail view -- opens the template picker with this
  // project (and its client) pre-selected.
  window.startQuestionnaireForProject = function startQuestionnaireForProject(projectId, clientId) {
    window.openCreateFromTemplateModal(null, { projectId, clientId });
  };

  // ============================================================
  // QUESTIONNAIRES: OVERVIEW
  // ============================================================

  async function loadQuestionnairesOverview() {
    const statsEl = document.getElementById('questionnaire-stats');
    const recentEl = document.getElementById('questionnaire-recent-list');
    const completedEl = document.getElementById('questionnaire-recent-completed');
    if (!statsEl) return;
    statsEl.innerHTML = '<div class="state-message">Loading…</div>';
    recentEl.innerHTML = '';
    completedEl.innerHTML = '';

    try {
      const data = await api('/api/questionnaires?action=dashboard');
      statsEl.innerHTML = `
        <div class="stat-card"><span>Total Questionnaires</span><strong>${data.totalQuestionnaires}</strong></div>
        <div class="stat-card"><span>Templates</span><strong>${data.templateCount}</strong></div>
        <div class="stat-card"><span>Drafts</span><strong>${data.draftCount}</strong></div>
        <div class="stat-card"><span>Pending</span><strong>${data.pendingCount}</strong></div>
        <div class="stat-card"><span>In Progress</span><strong>${data.inProgressCount}</strong></div>
        <div class="stat-card"><span>Completed</span><strong>${data.completedCount}</strong></div>
        <div class="stat-card"><span>Completion Rate</span><strong>${data.completionRate}%</strong></div>
        <div class="stat-card"><span>Avg. Completion Time</span><strong>${formatDuration(data.averageCompletionTimeSeconds)}</strong></div>
      `;
      recentEl.innerHTML = data.recentQuestionnaires.length ? renderQuestionnaireMiniList(data.recentQuestionnaires) : '<div class="state-message">No questionnaires yet.</div>';
      completedEl.innerHTML = data.recentlyCompleted.length ? renderQuestionnaireMiniList(data.recentlyCompleted) : '<div class="state-message">Nothing completed yet.</div>';
    } catch (error) {
      statsEl.innerHTML = `<div class="state-message is-error">${escapeHtml(error.message)}</div>`;
    }
  }

  function formatDuration(seconds) {
    if (seconds == null) return '—';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function renderQuestionnaireMiniList(list) {
    return list.map(q => `
      <div class="preview-question" style="margin-bottom:8px;">
        <a class="text-link" href="#/questionnaires/builder/instance/${q.id}">${escapeHtml(q.title)}</a>
        ${badge(q.status)}
        <span class="cell-muted"> · ${escapeHtml(q.clientName || 'Unattached')}${q.projectName ? ` · ${escapeHtml(q.projectName)}` : ''}</span>
      </div>
    `).join('');
  }

  window.loadQuestionnairesOverview = loadQuestionnairesOverview;

  // ============================================================
  // QUESTIONNAIRES: REUSABLE LIST (templates / drafts / pending / completed / archived)
  // ============================================================

  const LIST_FILTERS = {
    templates: { title: 'Templates', source: 'templates' },
    drafts: { title: 'Drafts', source: 'instances', status: 'Draft' },
    pending: { title: 'Pending', source: 'instances', status: 'Published,Sent,Viewed,InProgress' },
    completed: { title: 'Completed', source: 'instances', status: 'Completed' },
    archived: { title: 'Archived', source: 'instances', status: 'Archived' }
  };

  let currentListFilter = 'drafts';
  let currentListRows = [];

  async function loadQuestionnairesList(filterKey) {
    const config = LIST_FILTERS[filterKey] || LIST_FILTERS.drafts;
    currentListFilter = filterKey;
    document.getElementById('questionnaires-list-title').textContent = config.title;
    document.getElementById('questionnaire-sort-group').classList.toggle('hidden', config.source === 'templates');
    document.querySelectorAll('#questionnaires-list-subnav a').forEach(link => {
      link.classList.toggle('active', link.dataset.filter === filterKey);
    });

    const panel = document.getElementById('questionnaires-list-panel');
    panel.innerHTML = '<div class="state-message">Loading…</div>';
    const search = document.getElementById('questionnaire-search')?.value.trim() || '';
    const sort = document.getElementById('questionnaire-sort')?.value || 'newest';

    try {
      if (config.source === 'templates') {
        const params = new URLSearchParams({ action: 'list' });
        if (search) params.set('search', search);
        const data = await api(`/api/questionnaire-templates?${params}`);
        currentListRows = data.templates;
        panel.innerHTML = renderTemplatesTable(currentListRows);
      } else {
        const params = new URLSearchParams({ action: 'list', sort, status: config.status });
        if (search) params.set('search', search);
        const data = await api(`/api/questionnaires?${params}`);
        currentListRows = data.questionnaires;
        panel.innerHTML = renderQuestionnairesTable(currentListRows, filterKey);
      }
    } catch (error) {
      panel.innerHTML = `<div class="state-message is-error">${escapeHtml(error.message)}</div>`;
    }
  }

  document.getElementById('questionnaire-search')?.addEventListener('input', debounced(() => loadQuestionnairesList(currentListFilter)));
  document.getElementById('questionnaire-sort')?.addEventListener('change', () => loadQuestionnairesList(currentListFilter));

  function renderTemplatesTable(list) {
    if (!list.length) return '<div class="state-message">No templates yet.</div>';
    const rows = list.map(t => `
      <tr data-id="${t.id}">
        <td data-label="Title">${escapeHtml(t.title)}</td>
        <td data-label="Status">${badge(t.status)}</td>
        <td data-label="Questions" class="cell-muted">${t.questionCount}</td>
        <td data-label="Updated" class="cell-muted">${formatDate(t.updatedAt)}</td>
        <td data-label="Actions">
          <div class="row-actions">
            <a href="#/questionnaires/builder/template/${t.id}">Edit</a>
            <button type="button" onclick="openCreateFromTemplateModal('${t.id}')">Create Client Copy</button>
            <button type="button" onclick="duplicateTemplate('${t.id}')">Duplicate</button>
            ${t.status !== 'Archived' ? `<button type="button" onclick="archiveTemplate('${t.id}')">Archive</button>` : ''}
            <button type="button" onclick="deleteTemplate('${t.id}')">Delete</button>
          </div>
        </td>
      </tr>
    `).join('');
    return `<table class="invoice-table"><thead><tr><th>Title</th><th>Status</th><th>Questions</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderQuestionnairesTable(list, filterKey) {
    if (!list.length) return '<div class="state-message">Nothing here yet.</div>';
    const showSent = filterKey === 'pending' || filterKey === 'completed';
    const rows = list.map(q => {
      const actions = [`<a href="#/questionnaires/builder/instance/${q.id}">Open</a>`];
      if (q.status === 'Draft') actions.push(`<button type="button" onclick="quickPublish('${q.id}')">Publish</button>`);
      if (q.status === 'Published') actions.push(`<button type="button" onclick="openSendModal('${q.id}', 'send')">Send</button>`);
      if (['Sent', 'Viewed', 'InProgress', 'Expired'].includes(q.status)) actions.push(`<button type="button" onclick="openSendModal('${q.id}', 'resend')">Resend</button>`, `<button type="button" onclick="openSendModal('${q.id}', 'reminder')">Remind</button>`);
      if (q.status !== 'Draft') actions.push(`<button type="button" onclick="copyQuestionnaireLink('${q.id}')">Copy Link</button>`);
      actions.push(`<button type="button" onclick="duplicateQuestionnaire('${q.id}')">Duplicate</button>`);
      if (q.status !== 'Archived') actions.push(`<button type="button" onclick="archiveQuestionnaire('${q.id}')">Archive</button>`);
      return `
        <tr data-id="${q.id}">
          <td data-label="Questionnaire">${escapeHtml(q.title)}</td>
          <td data-label="Client" class="cell-muted">${escapeHtml(q.clientName || '—')}</td>
          <td data-label="Project" class="cell-muted">${escapeHtml(q.projectName || '—')}</td>
          <td data-label="Status">${badge(q.status)}</td>
          <td data-label="Progress" class="cell-muted">${(q.progress && q.progress.completionPercentage) || 0}%</td>
          ${showSent ? `<td data-label="Sent" class="cell-muted">${formatDate(q.sentAt)}</td>` : ''}
          <td data-label="Actions"><div class="row-actions">${actions.join('')}</div></td>
        </tr>
      `;
    }).join('');
    return `<table class="invoice-table"><thead><tr><th>Questionnaire</th><th>Client</th><th>Project</th><th>Status</th><th>Progress</th>${showSent ? '<th>Sent</th>' : ''}<th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  window.loadQuestionnairesList = loadQuestionnairesList;

  function refreshCurrentList() {
    if (document.getElementById('view-questionnaires-list')?.hidden === false) loadQuestionnairesList(currentListFilter);
    if (document.getElementById('view-questionnaires-overview')?.hidden === false) loadQuestionnairesOverview();
  }

  // ---------- Template quick actions ----------

  window.duplicateTemplate = async function duplicateTemplate(id) {
    try {
      await api('/api/questionnaire-templates?action=duplicate', { method: 'POST', body: JSON.stringify({ id }) });
      refreshCurrentList();
    } catch (error) { toast(error.message, 'error'); }
  };

  window.archiveTemplate = function archiveTemplate(id) {
    requestConfirmation('Archive this template? It will no longer appear when creating a new client questionnaire.', async () => {
      try {
        await api('/api/questionnaire-templates?action=archive', { method: 'POST', body: JSON.stringify({ id }) });
        closeModal();
        refreshCurrentList();
      } catch (error) { toast(error.message, 'error'); }
    }, 'Archive');
  };

  window.deleteTemplate = function deleteTemplate(id) {
    requestConfirmation('Delete this template permanently? Questionnaires already created from it are not affected.', async () => {
      try {
        await api('/api/questionnaire-templates?action=delete', { method: 'POST', body: JSON.stringify({ id }) });
        closeModal();
        refreshCurrentList();
      } catch (error) { toast(error.message, 'error'); }
    }, 'Delete');
  };

  // ---------- Questionnaire instance quick actions ----------

  window.quickPublish = async function quickPublish(id) {
    try {
      await api('/api/questionnaires?action=publish', { method: 'POST', body: JSON.stringify({ id }) });
      refreshCurrentList();
    } catch (error) { toast(error.message, 'error'); }
  };

  window.duplicateQuestionnaire = async function duplicateQuestionnaire(id) {
    try {
      await api('/api/questionnaires?action=duplicate', { method: 'POST', body: JSON.stringify({ id }) });
      refreshCurrentList();
    } catch (error) { toast(error.message, 'error'); }
  };

  window.archiveQuestionnaire = function archiveQuestionnaire(id) {
    requestConfirmation('Archive this questionnaire?', async () => {
      try {
        await api('/api/questionnaires?action=archive', { method: 'POST', body: JSON.stringify({ id }) });
        closeModal();
        refreshCurrentList();
      } catch (error) { toast(error.message, 'error'); }
    }, 'Archive');
  };

  window.copyQuestionnaireLink = async function copyQuestionnaireLink(id, buttonEl) {
    try {
      const { questionnaire } = await api(`/api/questionnaires?action=get&id=${encodeURIComponent(id)}`);
      if (!questionnaire.respondLink) throw new Error('This questionnaire has not been sent yet.');
      await copyToClipboard(questionnaire.respondLink, buttonEl);
    } catch (error) { toast(error.message, 'error'); }
  };

  // ============================================================
  // CREATE FROM TEMPLATE MODAL
  // ============================================================

  let templatesForModal = [];

  window.openCreateFromTemplateModal = async function openCreateFromTemplateModal(templateId, presets = {}) {
    const statusEl = document.getElementById('cft-status');
    statusEl.textContent = '';
    document.getElementById('create-from-template-form').reset();

    await window.populateClientProjectSelects();

    const templateSelect = document.getElementById('cft-template');
    const templateGroup = document.getElementById('cft-template-group');
    try {
      const data = await api('/api/questionnaire-templates?action=list&status=Published');
      templatesForModal = data.templates;
      if (!templatesForModal.length) {
        statusEl.textContent = 'No published templates yet. Publish a template first, or create a blank questionnaire instead.';
      }
      templateSelect.innerHTML = templatesForModal.map(t => `<option value="${t.id}">${escapeHtml(t.title)}</option>`).join('');
    } catch (error) {
      statusEl.textContent = error.message;
    }

    if (templateId) {
      templateSelect.value = templateId;
      templateGroup.classList.add('hidden');
      const template = templatesForModal.find(t => t.id === templateId);
      if (template) document.getElementById('cft-title').value = template.title;
    } else {
      templateGroup.classList.remove('hidden');
    }

    if (presets.clientId) document.getElementById('cft-client').value = presets.clientId;
    if (presets.projectId) document.getElementById('cft-project').value = presets.projectId;

    openModalWithNode('New Questionnaire From Template', 'create-from-template-card');
  };

  // A project always determines its own client -- selecting one disables the client
  // select and forces it to match, matching the backend's own resolveAttachments rule.
  document.getElementById('cft-project')?.addEventListener('change', event => {
    const clientId = event.target.selectedOptions[0]?.dataset.clientId || '';
    const clientSelect = document.getElementById('cft-client');
    if (event.target.value) {
      clientSelect.value = clientId;
      clientSelect.disabled = true;
    } else {
      clientSelect.disabled = false;
    }
  });

  window.submitCreateFromTemplate = async function submitCreateFromTemplate(event) {
    event.preventDefault();
    const statusEl = document.getElementById('cft-status');
    statusEl.textContent = '';
    const templateId = document.getElementById('cft-template').value;
    if (!templateId) { statusEl.textContent = 'Select a template.'; return; }

    const payload = {
      templateId,
      title: document.getElementById('cft-title').value.trim(),
      clientId: document.getElementById('cft-client').value || undefined,
      projectId: document.getElementById('cft-project').value || undefined
    };
    try {
      const { questionnaire } = await api('/api/questionnaires?action=createfromtemplate', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      window.location.hash = `#/questionnaires/builder/instance/${questionnaire.id}`;
    } catch (error) {
      statusEl.textContent = error.message;
    }
  };

  // ============================================================
  // SEND / RESEND / REMIND MODAL (also used from the builder)
  // ============================================================

  window.openSendModal = async function openSendModal(id, mode = 'send') {
    id = id || window.currentBuilderId?.();
    if (!id) return;
    const form = document.getElementById('send-questionnaire-form');
    form.reset();
    document.getElementById('send-questionnaire-id').value = id;
    document.getElementById('send-questionnaire-mode').value = mode;
    document.getElementById('send-form-status').textContent = '';
    document.getElementById('send-form-submit').textContent = mode === 'send' ? 'Send' : (mode === 'resend' ? 'Resend' : 'Send Reminder');

    try {
      const { questionnaire, client } = await api(`/api/questionnaires?action=get&id=${encodeURIComponent(id)}`);
      document.getElementById('send-recipient-email').value = questionnaire.recipientEmail || client?.email || '';
    } catch { /* leave blank, admin can type it in */ }

    openModalWithNode(mode === 'send' ? 'Send Questionnaire' : (mode === 'resend' ? 'Resend Questionnaire' : 'Send Reminder'), 'send-questionnaire-card');
  };

  window.submitSendQuestionnaire = async function submitSendQuestionnaire(event) {
    event.preventDefault();
    const statusEl = document.getElementById('send-form-status');
    statusEl.textContent = '';
    const submitButton = document.getElementById('send-form-submit');
    submitButton.disabled = true;

    const id = document.getElementById('send-questionnaire-id').value;
    const mode = document.getElementById('send-questionnaire-mode').value;
    const action = mode === 'send' ? 'send' : (mode === 'resend' ? 'resend' : 'remind');
    const payload = {
      id,
      recipientEmail: document.getElementById('send-recipient-email').value.trim(),
      customMessage: document.getElementById('send-custom-message').value.trim()
    };
    const expiration = document.getElementById('send-expiration').value;
    if (expiration) payload.expiresAt = expiration;

    try {
      await api(`/api/questionnaires?action=${action}`, { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      refreshCurrentList();
      window.reloadBuilderAfterSend?.(id);
    } catch (error) {
      statusEl.textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  };

  // Namespaced view onto the same functions above, for anything that wants to call
  // in without depending on bare globals (the globals themselves stay -- see the file
  // header comment -- because admin.html and generated row markup call these by bare
  // name via onclick="").
  window.PerlerAdmin.clients = {
    load: loadClients, loadDetail: loadClientDetail,
    openForm: window.openClientForm, submitForm: window.submitClientForm, delete: window.deleteClient
  };
  window.PerlerAdmin.projects = {
    load: loadProjects, loadDetail: loadProjectDetail,
    openForm: window.openProjectForm, submitForm: window.submitProjectForm, delete: window.deleteProject
  };
  window.PerlerAdmin.questionnaires = {
    loadOverview: loadQuestionnairesOverview, loadList: loadQuestionnairesList,
    publish: window.quickPublish, duplicate: window.duplicateQuestionnaire, archive: window.archiveQuestionnaire,
    copyLink: window.copyQuestionnaireLink,
    openCreateFromTemplate: window.openCreateFromTemplateModal, openSend: window.openSendModal
  };
  window.PerlerAdmin.templates = {
    duplicate: window.duplicateTemplate, archive: window.archiveTemplate, delete: window.deleteTemplate
  };
})();
