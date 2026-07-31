// Questionnaire/template builder. Organized into clearly separated concerns below
// (search for the "---------- Name ----------" markers):
//   1. State & loading           4. Structural mutations (sections/questions/options)
//   2. Rendering + conditional   5. Drag-and-drop (+ Move Up/Down accessible alt)
//      logic editor              6. Save status / save / publish / send
//                                 7. Preview
// Shared utilities come from window.PerlerAdmin (see js/admin.js); form rendering
// comes from window.FormRenderer (see js/questionnaire-renderer.js).
(() => {
  const { api, ui, format, dom } = window.PerlerAdmin;
  const { escapeHtml } = format;
  const { openModal: openModalWithNode, closeModal, confirm: requestConfirmation, toast } = ui;
  const { copyToClipboard } = dom;
  const R = () => window.FormRenderer;

  const QUESTION_TYPES = [
    ['short_answer', 'Short answer'], ['long_answer', 'Long paragraph'],
    ['multiple_choice', 'Multiple choice'], ['checkboxes', 'Checkboxes'], ['dropdown', 'Dropdown'],
    ['yes_no', 'Yes / No'], ['number', 'Number'], ['date', 'Date'],
    ['rating_5', 'Rating (1-5)'], ['rating_10', 'Rating (1-10)'],
    ['file_upload', 'File upload'], ['image_upload', 'Image upload'],
    ['section_divider', 'Section divider'], ['heading', 'Heading / info text']
  ];
  const CHOICE_TYPES = ['multiple_choice', 'checkboxes', 'dropdown'];
  const LAYOUT_TYPES = ['section_divider', 'heading'];
  // Must mirror lib/questionnaire-validation.js's CONDITION_SOURCE_TYPES.
  const CONDITION_SOURCE_TYPES = ['multiple_choice', 'checkboxes', 'dropdown', 'yes_no'];
  // Must mirror lib/questionnaire-validation.js's file-upload constants.
  const FILE_CONSTRAINTS = {
    file_upload: 'Up to 15 MB. Allowed: images, PDF, Word documents (.doc/.docx), and plain text.',
    image_upload: 'Up to 15 MB. Allowed: JPG, PNG, WEBP, GIF, HEIC.'
  };

  let builderKind = null; // 'template' | 'instance'
  let builderId = null;
  let doc = null; // { title, description, sections, status, ... }
  let hasUnsavedChanges = false;
  let saveInFlight = false;
  let saveQueued = false;
  let autosaveTimer = null;
  let uid = 0;
  const newId = () => `new-${Date.now()}-${uid++}`;

  function isTemplate() { return builderKind === 'template'; }
  function isContentLocked() { return !isTemplate() && doc && !['Draft', 'Published'].includes(doc.status); }

  function emptyQuestion(type) {
    return {
      id: newId(), type, label: '', helperText: '', required: false,
      options: CHOICE_TYPES.includes(type) ? [{ id: newId(), label: 'Option 1' }] : [],
      allowOther: false, conditionalLogic: null
    };
  }
  function emptySection() {
    return { id: newId(), title: 'New Section', description: '', questions: [], conditionalLogic: null };
  }

  // ---------- Loading ----------

  window.loadQuestionnaireBuilder = async function loadQuestionnaireBuilder(kind, id) {
    builderKind = kind === 'template' ? 'template' : 'instance';
    builderId = id && id !== 'new' ? id : null;
    hasUnsavedChanges = false;
    clearTimeout(autosaveTimer);

    // The header/section shell always lives in admin.html and is never replaced --
    // only #builder-sections' contents are swapped for a loading/error state, so the
    // title/description/action-button elements are never destroyed and recreated.
    const sectionsEl = document.getElementById('builder-sections');
    if (!builderId) {
      doc = { title: '', description: '', sections: [], status: 'Draft' };
      renderBuilder();
      return;
    }

    sectionsEl.innerHTML = '<div class="state-message">Loading…</div>';
    try {
      if (isTemplate()) {
        const { template } = await api(`/api/questionnaire-templates?action=get&id=${encodeURIComponent(builderId)}`);
        doc = template;
      } else {
        const { questionnaire, client, project } = await api(`/api/questionnaires?action=get&id=${encodeURIComponent(builderId)}`);
        doc = questionnaire;
        doc.clientName = client?.name || null;
        doc.projectName = project?.name || null;
      }
    } catch (error) {
      sectionsEl.innerHTML = `<div class="state-message is-error">${escapeHtml(error.message)}</div>`;
      return;
    }
    renderBuilder();
  };

  // ---------- Rendering ----------
  // (conditional-logic evaluation/editing lives here too, in
  // flattenedEarlierQuestions/cleanConditionalLogic/conditionalEditorHtml just below
  // -- kept with rendering rather than split out, since its only job is deciding what
  // the question/section cards show)

  function flattenedEarlierQuestions(uptoSectionIndex, uptoQuestionIndex) {
    const list = [];
    doc.sections.forEach((section, sIdx) => {
      section.questions.forEach((question, qIdx) => {
        const isBefore = sIdx < uptoSectionIndex || (sIdx === uptoSectionIndex && qIdx < uptoQuestionIndex);
        if (isBefore && CONDITION_SOURCE_TYPES.includes(question.type)) list.push(question);
      });
    });
    return list;
  }

  // Drops any conditionalLogic whose source question no longer exists / no longer
  // qualifies -- called before every render so a deleted or retyped source question
  // never leaves a dangling, invisible-to-the-admin condition.
  function cleanConditionalLogic() {
    doc.sections.forEach((section, sIdx) => {
      const sectionCandidates = flattenedEarlierQuestions(sIdx, 0).map(q => q.id);
      if (section.conditionalLogic && !sectionCandidates.includes(section.conditionalLogic.questionId)) section.conditionalLogic = null;
      section.questions.forEach((question, qIdx) => {
        const candidates = flattenedEarlierQuestions(sIdx, qIdx).map(q => q.id);
        if (question.conditionalLogic && !candidates.includes(question.conditionalLogic.questionId)) question.conditionalLogic = null;
      });
    });
  }

  function conditionalEditorHtml(pathAttrs, logic, candidates) {
    if (!candidates.length) return '';
    const sourceQuestion = candidates.find(q => q.id === logic?.questionId);
    const options = sourceQuestion?.options || [];
    return `
      <div class="conditional-box">
        <p class="field-hint">Show only when...</p>
        <div class="conditional-row">
          <div class="select-wrap">
            <select ${pathAttrs} data-cond-field="questionId">
              <option value="">Always show</option>
              ${candidates.map(q => `<option value="${q.id}" ${logic?.questionId === q.id ? 'selected' : ''}>${escapeHtml(q.label || '(untitled question)')}</option>`).join('')}
            </select>
          </div>
          <div class="select-wrap">
            <select ${pathAttrs} data-cond-field="operator" ${!logic ? 'disabled' : ''}>
              <option value="equals" ${logic?.operator === 'equals' ? 'selected' : ''}>equals</option>
              <option value="notEquals" ${logic?.operator === 'notEquals' ? 'selected' : ''}>does not equal</option>
              ${sourceQuestion?.type === 'checkboxes' ? `<option value="includes" ${logic?.operator === 'includes' ? 'selected' : ''}>includes</option>` : ''}
            </select>
          </div>
          ${sourceQuestion && sourceQuestion.type === 'yes_no'
            ? `<div class="select-wrap"><select ${pathAttrs} data-cond-field="value"><option value="Yes" ${logic?.value === 'Yes' ? 'selected' : ''}>Yes</option><option value="No" ${logic?.value === 'No' ? 'selected' : ''}>No</option></select></div>`
            : sourceQuestion && options.length
              ? `<div class="select-wrap"><select ${pathAttrs} data-cond-field="value">${options.map(o => `<option value="${escapeHtml(o.label)}" ${logic?.value === o.label ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select></div>`
              : `<input type="text" ${pathAttrs} data-cond-field="value" placeholder="Expected value" value="${escapeHtml(logic?.value || '')}" ${!logic ? 'disabled' : ''}>`}
        </div>
        ${logic && sourceQuestion ? `<p class="conditional-summary">Show when "${escapeHtml(sourceQuestion.label || '(untitled)')}" ${logic.operator === 'notEquals' ? 'does not equal' : (logic.operator === 'includes' ? 'includes' : 'equals')} "${escapeHtml(logic.value || '')}"</p>` : ''}
      </div>
    `;
  }

  function questionCardHtml(sectionIdx, questionIdx, question) {
    const locked = isContentLocked();
    const isLayout = LAYOUT_TYPES.includes(question.type);
    const path = `data-section-idx="${sectionIdx}" data-question-idx="${questionIdx}"`;
    const candidates = flattenedEarlierQuestions(sectionIdx, questionIdx);

    return `
      <div class="question-card" draggable="${!locked}" data-drag-type="question" ${path}>
        <div class="question-card-top">
          <button class="drag-handle" type="button" aria-label="Drag to reorder question" ${locked ? 'disabled' : ''}>⠿</button>
          <div class="question-card-main">
            <div class="question-type-row">
              <input type="text" ${path} data-field="label" placeholder="${isLayout ? (question.type === 'heading' ? 'Heading text' : 'Section divider label (optional)') : 'Question label'}" value="${escapeHtml(question.label)}" ${locked ? 'disabled' : ''}>
              <div class="select-wrap">
                <select ${path} data-field="type" ${locked ? 'disabled' : ''}>
                  ${QUESTION_TYPES.map(([value, label]) => `<option value="${value}" ${question.type === value ? 'selected' : ''}>${label}</option>`).join('')}
                </select>
              </div>
            </div>
            ${!isLayout ? `<input type="text" ${path} data-field="helperText" placeholder="Optional helper text" value="${escapeHtml(question.helperText || '')}" ${locked ? 'disabled' : ''}>` : ''}
            ${!isLayout ? `<label class="required-toggle"><input type="checkbox" ${path} data-field="required" ${question.required ? 'checked' : ''} ${locked ? 'disabled' : ''}> Required</label>` : ''}
            ${CHOICE_TYPES.includes(question.type) ? optionsEditorHtml(sectionIdx, questionIdx, question, locked) : ''}
            ${question.type === 'rating_5' ? '<p class="field-hint">Respondents choose a rating from 1 to 5.</p>' : ''}
            ${question.type === 'rating_10' ? '<p class="field-hint">Respondents choose a rating from 1 to 10.</p>' : ''}
            ${FILE_CONSTRAINTS[question.type] ? `<p class="file-constraints-note">${FILE_CONSTRAINTS[question.type]}</p>` : ''}
            ${!isLayout ? conditionalEditorHtml(`${path.replace(/"/g, '&quot;')}`, question.conditionalLogic, candidates) : ''}
          </div>
          <div class="question-card-tools">
            <button class="icon-button" type="button" title="Move up" aria-label="Move question up" onclick="moveQuestion(${sectionIdx},${questionIdx},-1)" ${locked || questionIdx === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon-button" type="button" title="Move down" aria-label="Move question down" onclick="moveQuestion(${sectionIdx},${questionIdx},1)" ${locked || questionIdx === doc.sections[sectionIdx].questions.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="icon-button" type="button" title="Move to previous section" aria-label="Move question to previous section" onclick="moveQuestionToSection(${sectionIdx},${questionIdx},-1)" ${locked || sectionIdx === 0 ? 'disabled' : ''}>⇤</button>
            <button class="icon-button" type="button" title="Move to next section" aria-label="Move question to next section" onclick="moveQuestionToSection(${sectionIdx},${questionIdx},1)" ${locked || sectionIdx === doc.sections.length - 1 ? 'disabled' : ''}>⇥</button>
            <button class="icon-button" type="button" title="Duplicate" aria-label="Duplicate question" onclick="duplicateQuestion(${sectionIdx},${questionIdx})" ${locked ? 'disabled' : ''}>⧉</button>
            <button class="icon-button" type="button" title="Delete" aria-label="Delete question" onclick="deleteQuestion(${sectionIdx},${questionIdx})" ${locked ? 'disabled' : ''}>✕</button>
          </div>
        </div>
      </div>
    `;
  }

  function optionsEditorHtml(sectionIdx, questionIdx, question, locked) {
    const rows = question.options.map((option, optionIdx) => `
      <div class="option-row" data-section-idx="${sectionIdx}" data-question-idx="${questionIdx}" data-option-idx="${optionIdx}">
        <input type="text" data-option-field="label" value="${escapeHtml(option.label)}" placeholder="Option label" ${locked ? 'disabled' : ''}>
        <button class="icon-button" type="button" title="Move up" aria-label="Move option up" onclick="moveOption(${sectionIdx},${questionIdx},${optionIdx},-1)" ${locked || optionIdx === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-button" type="button" title="Move down" aria-label="Move option down" onclick="moveOption(${sectionIdx},${questionIdx},${optionIdx},1)" ${locked ? 'disabled' : ''}>↓</button>
        <button class="icon-button" type="button" title="Remove option" aria-label="Remove option" onclick="removeOption(${sectionIdx},${questionIdx},${optionIdx})" ${locked || question.options.length <= 1 ? 'disabled' : ''}>✕</button>
      </div>
    `).join('');
    return `
      <div class="options-list" data-section-idx="${sectionIdx}" data-question-idx="${questionIdx}">
        ${rows}
        <div class="form-actions">
          <button class="button button-secondary" type="button" onclick="addOption(${sectionIdx},${questionIdx})" ${locked ? 'disabled' : ''}>Add Option</button>
        </div>
        <label class="required-toggle"><input type="checkbox" data-field="allowOther" data-section-idx="${sectionIdx}" data-question-idx="${questionIdx}" ${question.allowOther ? 'checked' : ''} ${locked ? 'disabled' : ''}> Include an "Other" option</label>
      </div>
    `;
  }

  function sectionCardHtml(sectionIdx, section) {
    const locked = isContentLocked();
    const candidates = flattenedEarlierQuestions(sectionIdx, 0);
    return `
      <div class="section-card" draggable="${!locked}" data-drag-type="section" data-section-idx="${sectionIdx}">
        <div class="section-card-header">
          <button class="drag-handle" type="button" aria-label="Drag to reorder section" ${locked ? 'disabled' : ''}>⠿</button>
          <div class="section-card-fields">
            <input type="text" class="section-title-input" data-section-idx="${sectionIdx}" data-field="title" placeholder="Section title" value="${escapeHtml(section.title)}" ${locked ? 'disabled' : ''}>
            <input type="text" data-section-idx="${sectionIdx}" data-field="description" placeholder="Optional section description" value="${escapeHtml(section.description || '')}" ${locked ? 'disabled' : ''}>
            <div class="section-conditional-summary">${conditionalEditorHtml(`data-section-idx="${sectionIdx}" data-section-cond="1"`, section.conditionalLogic, candidates)}</div>
          </div>
          <div class="section-card-tools">
            <button class="icon-button" type="button" title="Move up" aria-label="Move section up" onclick="moveSection(${sectionIdx},-1)" ${locked || sectionIdx === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon-button" type="button" title="Move down" aria-label="Move section down" onclick="moveSection(${sectionIdx},1)" ${locked ? 'disabled' : ''}>↓</button>
            <button class="icon-button" type="button" title="Duplicate section" aria-label="Duplicate section" onclick="duplicateSection(${sectionIdx})" ${locked ? 'disabled' : ''}>⧉</button>
            <button class="icon-button" type="button" title="Delete section" aria-label="Delete section" onclick="deleteSection(${sectionIdx})" ${locked ? 'disabled' : ''}>✕</button>
          </div>
        </div>
        <div class="section-card-body">
          ${section.questions.map((q, qIdx) => questionCardHtml(sectionIdx, qIdx, q)).join('') || '<p class="empty-state-inline">No questions in this section yet.</p>'}
          <div class="form-actions">
            <button class="button button-secondary" type="button" onclick="addQuestion(${sectionIdx})" ${locked ? 'disabled' : ''}>Add Question</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderBuilder() {
    cleanConditionalLogic();

    document.getElementById('builder-title').value = doc.title || '';
    document.getElementById('builder-title').disabled = isContentLocked();
    document.getElementById('builder-description').value = doc.description || '';
    document.getElementById('builder-description').disabled = isContentLocked();

    const notice = document.getElementById('builder-lock-notice');
    notice.innerHTML = isContentLocked()
      ? `<div class="lock-notice">This questionnaire has already been sent, so its content is locked and can no longer be edited. Duplicate it if you need to make changes.</div>`
      : '';

    document.getElementById('builder-sections').innerHTML = doc.sections.length
      ? doc.sections.map((section, idx) => sectionCardHtml(idx, section)).join('')
      : '<p class="empty-state-inline">No sections yet. Add one to get started.</p>';

    document.querySelector('#view-questionnaire-builder .admin-panel .form-actions > button[onclick="addBuilderSection()"]')?.toggleAttribute('disabled', isContentLocked());

    bindFieldListeners();
    bindDragAndDrop();
    updateActionButtons();
  }

  function bindFieldListeners() {
    const container = document.getElementById('builder-sections');

    container.querySelectorAll('[data-section-idx][data-field]:not([data-question-idx])').forEach(el => {
      el.addEventListener('input', () => {
        const s = doc.sections[Number(el.dataset.sectionIdx)];
        s[el.dataset.field] = el.value;
        markUnsaved();
      });
    });

    container.querySelectorAll('[data-question-idx][data-field]').forEach(el => {
      const handler = () => {
        const q = doc.sections[Number(el.dataset.sectionIdx)].questions[Number(el.dataset.questionIdx)];
        if (el.dataset.field === 'required' || el.dataset.field === 'allowOther') q[el.dataset.field] = el.checked;
        else if (el.dataset.field === 'type') { changeQuestionType(q, el.value); renderBuilder(); return; }
        else q[el.dataset.field] = el.value;
        markUnsaved();
      };
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', handler);
    });

    container.querySelectorAll('[data-option-field]').forEach(el => {
      el.addEventListener('input', () => {
        const row = el.closest('[data-option-idx]');
        const q = doc.sections[Number(row.dataset.sectionIdx)].questions[Number(row.dataset.questionIdx)];
        q.options[Number(row.dataset.optionIdx)].label = el.value;
        markUnsaved();
      });
    });

    container.querySelectorAll('[data-cond-field]').forEach(el => {
      el.addEventListener('change', () => {
        const isSection = el.hasAttribute('data-section-cond');
        const target = isSection
          ? doc.sections[Number(el.dataset.sectionIdx)]
          : doc.sections[Number(el.dataset.sectionIdx)].questions[Number(el.dataset.questionIdx)];
        const box = el.closest('.conditional-box');
        const questionId = box.querySelector('[data-cond-field="questionId"]').value;
        if (!questionId) { target.conditionalLogic = null; }
        else {
          const operator = box.querySelector('[data-cond-field="operator"]')?.value || 'equals';
          const value = box.querySelector('[data-cond-field="value"]')?.value || '';
          target.conditionalLogic = { questionId, operator, value };
        }
        markUnsaved();
        renderBuilder();
      });
    });
  }

  function changeQuestionType(question, newType) {
    question.type = newType;
    if (LAYOUT_TYPES.includes(newType)) { question.required = false; question.conditionalLogic = null; }
    if (CHOICE_TYPES.includes(newType) && !question.options.length) question.options = [{ id: newId(), label: 'Option 1' }];
    if (!CHOICE_TYPES.includes(newType)) { question.options = []; question.allowOther = false; }
  }

  // ---------- Drag and drop (native HTML5 DnD; Move Up/Down buttons above are the
  // accessible / keyboard-operable equivalent for the exact same reordering). ----------

  function bindDragAndDrop() {
    const container = document.getElementById('builder-sections');
    let dragged = null;

    container.querySelectorAll('[draggable="true"][data-drag-type="section"]').forEach(el => {
      el.addEventListener('dragstart', () => { dragged = { type: 'section', idx: Number(el.dataset.sectionIdx) }; });
      el.addEventListener('dragover', event => { event.preventDefault(); if (dragged?.type === 'section') el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', event => {
        event.preventDefault();
        el.classList.remove('drag-over');
        if (dragged?.type !== 'section') return;
        const target = Number(el.dataset.sectionIdx);
        const [moved] = doc.sections.splice(dragged.idx, 1);
        doc.sections.splice(target, 0, moved);
        markUnsaved(); renderBuilder();
      });
    });

    container.querySelectorAll('[draggable="true"][data-drag-type="question"]').forEach(el => {
      el.addEventListener('dragstart', event => {
        event.stopPropagation();
        dragged = { type: 'question', sectionIdx: Number(el.dataset.sectionIdx), idx: Number(el.dataset.questionIdx) };
      });
      el.addEventListener('dragover', event => { event.preventDefault(); event.stopPropagation(); if (dragged?.type === 'question') el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', event => {
        event.preventDefault();
        event.stopPropagation();
        el.classList.remove('drag-over');
        if (dragged?.type !== 'question') return;
        const targetSectionIdx = Number(el.dataset.sectionIdx);
        const targetIdx = Number(el.dataset.questionIdx);
        const [moved] = doc.sections[dragged.sectionIdx].questions.splice(dragged.idx, 1);
        doc.sections[targetSectionIdx].questions.splice(targetIdx, 0, moved);
        markUnsaved(); renderBuilder();
      });
    });
  }

  // ---------- Structural mutations (also reachable via the Move Up/Down/Duplicate/
  // Delete buttons, which are the accessible alternative to drag-and-drop) ----------

  window.addBuilderSection = function addBuilderSection() { doc.sections.push(emptySection()); markUnsaved(); renderBuilder(); };
  window.moveSection = function moveSection(idx, dir) {
    const target = idx + dir;
    if (target < 0 || target >= doc.sections.length) return;
    const [moved] = doc.sections.splice(idx, 1);
    doc.sections.splice(target, 0, moved);
    markUnsaved(); renderBuilder();
  };
  window.duplicateSection = function duplicateSection(idx) {
    const copy = JSON.parse(JSON.stringify(doc.sections[idx]));
    copy.id = newId();
    copy.questions.forEach(q => { q.id = newId(); q.options?.forEach(o => { o.id = newId(); }); });
    doc.sections.splice(idx + 1, 0, copy);
    markUnsaved(); renderBuilder();
  };
  window.deleteSection = function deleteSection(idx) {
    requestConfirmation('Delete this section and all of its questions?', async () => {
      doc.sections.splice(idx, 1);
      markUnsaved();
      closeModal();
      renderBuilder();
    }, 'Delete');
  };

  window.addQuestion = function addQuestion(sectionIdx) { doc.sections[sectionIdx].questions.push(emptyQuestion('short_answer')); markUnsaved(); renderBuilder(); };
  window.moveQuestion = function moveQuestion(sectionIdx, idx, dir) {
    const questions = doc.sections[sectionIdx].questions;
    const target = idx + dir;
    if (target < 0 || target >= questions.length) return;
    const [moved] = questions.splice(idx, 1);
    questions.splice(target, 0, moved);
    markUnsaved(); renderBuilder();
  };
  // Accessible alternative to dragging a question card into a different section --
  // moves it to the end of the previous/next section's question list.
  window.moveQuestionToSection = function moveQuestionToSection(sectionIdx, idx, dir) {
    const targetSectionIdx = sectionIdx + dir;
    if (targetSectionIdx < 0 || targetSectionIdx >= doc.sections.length) return;
    const [moved] = doc.sections[sectionIdx].questions.splice(idx, 1);
    doc.sections[targetSectionIdx].questions.push(moved);
    markUnsaved(); renderBuilder();
  };
  window.duplicateQuestion = function duplicateQuestion(sectionIdx, idx) {
    const copy = JSON.parse(JSON.stringify(doc.sections[sectionIdx].questions[idx]));
    copy.id = newId();
    copy.options?.forEach(o => { o.id = newId(); });
    doc.sections[sectionIdx].questions.splice(idx + 1, 0, copy);
    markUnsaved(); renderBuilder();
  };
  window.deleteQuestion = function deleteQuestion(sectionIdx, idx) {
    requestConfirmation('Delete this question?', async () => {
      doc.sections[sectionIdx].questions.splice(idx, 1);
      markUnsaved();
      closeModal();
      renderBuilder();
    }, 'Delete');
  };

  window.addOption = function addOption(sectionIdx, questionIdx) {
    doc.sections[sectionIdx].questions[questionIdx].options.push({ id: newId(), label: `Option ${doc.sections[sectionIdx].questions[questionIdx].options.length + 1}` });
    markUnsaved(); renderBuilder();
  };
  window.removeOption = function removeOption(sectionIdx, questionIdx, optionIdx) {
    const options = doc.sections[sectionIdx].questions[questionIdx].options;
    if (options.length <= 1) return; // the last option can never be removed from here
    options.splice(optionIdx, 1);
    markUnsaved(); renderBuilder();
  };
  window.moveOption = function moveOption(sectionIdx, questionIdx, optionIdx, dir) {
    const options = doc.sections[sectionIdx].questions[questionIdx].options;
    const target = optionIdx + dir;
    if (target < 0 || target >= options.length) return;
    const [moved] = options.splice(optionIdx, 1);
    options.splice(target, 0, moved);
    markUnsaved(); renderBuilder();
  };

  // ---------- Save status / unsaved-changes tracking ----------

  function markUnsaved() {
    hasUnsavedChanges = true;
    setSaveStatus('unsaved');
    if (!isContentLocked()) {
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => saveBuilder(), 2500);
    }
  }

  function setSaveStatus(state, message) {
    const el = document.getElementById('builder-save-status');
    if (!el) return;
    el.className = `save-status is-${state}`;
    el.textContent = state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? (message || 'Save failed') : 'Unsaved changes';
  }

  window.builderHasUnsavedChanges = () => hasUnsavedChanges;
  window.currentBuilderId = () => builderId;

  function buildContentPayload() {
    return {
      title: document.getElementById('builder-title').value.trim(),
      description: document.getElementById('builder-description').value.trim(),
      sections: doc.sections
    };
  }

  window.saveBuilder = async function saveBuilder() {
    if (isContentLocked()) return;
    if (saveInFlight) { saveQueued = true; return; }
    saveInFlight = true;
    setSaveStatus('saving');
    clearTimeout(autosaveTimer);

    const payload = buildContentPayload();
    const endpoint = isTemplate() ? '/api/questionnaire-templates' : '/api/questionnaires';
    const action = builderId ? (isTemplate() ? 'update' : 'savedraft') : (isTemplate() ? 'create' : 'createblank');
    if (builderId) payload.id = builderId;

    try {
      const result = await api(`${endpoint}?action=${action}`, { method: 'POST', body: JSON.stringify(payload) });
      const saved = isTemplate() ? result.template : result.questionnaire;
      const isNew = !builderId;
      builderId = saved.id;
      doc = { ...doc, ...saved };
      hasUnsavedChanges = false;
      setSaveStatus('saved');
      updateActionButtons();
      if (isNew) window.history.replaceState(null, '', `#/questionnaires/builder/${builderKind}/${builderId}`);
    } catch (error) {
      setSaveStatus('error', error.errors ? error.errors[0] : error.message);
      const extra = error.errors && error.errors.length > 1 ? ` (+${error.errors.length - 1} more issue${error.errors.length > 2 ? 's' : ''})` : '';
      toast(`${error.message}${extra}`, 'error');
    } finally {
      saveInFlight = false;
      if (saveQueued) { saveQueued = false; saveBuilder(); }
    }
  };

  window.publishBuilder = async function publishBuilder() {
    if (hasUnsavedChanges) await window.saveBuilder();
    if (!builderId) { toast('Save the questionnaire before publishing.', 'error'); return; }
    try {
      const endpoint = isTemplate() ? '/api/questionnaire-templates' : '/api/questionnaires';
      const action = isTemplate() ? 'update' : 'publish';
      const body = isTemplate() ? { id: builderId, ...buildContentPayload(), status: 'Published' } : { id: builderId };
      const result = await api(`${endpoint}?action=${action}`, { method: 'POST', body: JSON.stringify(body) });
      doc = { ...doc, ...(isTemplate() ? result.template : result.questionnaire) };
      updateActionButtons();
      renderBuilder();
      toast('Published.');
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  window.copyBuilderLink = async function copyBuilderLink(event) {
    if (!doc.respondLink) { toast('This questionnaire has not been sent yet.', 'error'); return; }
    await copyToClipboard(doc.respondLink, event?.currentTarget);
  };

  // Called by js/admin-questionnaires.js after a successful send/resend/remind so the
  // builder's status pill, Copy Link button, and lock state reflect it immediately.
  window.reloadBuilderAfterSend = async function reloadBuilderAfterSend(id) {
    if (id !== builderId || isTemplate()) return;
    const { questionnaire } = await api(`/api/questionnaires?action=get&id=${encodeURIComponent(builderId)}`);
    doc = { ...doc, ...questionnaire };
    renderBuilder();
  };

  function updateActionButtons() {
    const publishButton = document.getElementById('builder-publish-button');
    const saveButton = document.getElementById('builder-save-button');
    const copyLinkButton = document.getElementById('builder-copy-link-button');
    const sendButton = document.getElementById('builder-send-button');
    if (!publishButton) return;

    const status = doc.status || 'Draft';
    const locked = isContentLocked();

    saveButton.classList.toggle('hidden', locked);
    publishButton.classList.toggle('hidden', locked || status !== 'Draft');
    copyLinkButton.classList.toggle('hidden', !doc.respondLink);
    sendButton.classList.toggle('hidden', isTemplate() || !['Published', 'Sent', 'Viewed', 'InProgress', 'Expired'].includes(status));
    sendButton.textContent = status === 'Published' ? 'Send' : 'Resend / Remind';
    sendButton.onclick = () => window.openSendModal(builderId, status === 'Published' ? 'send' : 'resend');
  }

  // ---------- Preview ----------

  window.openBuilderPreview = function openBuilderPreview() {
    const previewDoc = { title: document.getElementById('builder-title').value, description: document.getElementById('builder-description').value, sections: doc.sections };
    openModalWithNode('Preview', 'preview-modal-card', { wide: true });
    const body = document.getElementById('preview-modal-body');
    R().renderQuestionnaireRunner(body, previewDoc, {
      submitLabel: 'Submit (Preview)',
      onSubmit: () => { body.innerHTML = '<p class="empty-state-inline">This is a preview -- no response was saved.</p>'; }
    });
  };

  // Namespaced view onto the same functions above -- see js/admin-questionnaires.js's
  // equivalent block for why the bare window.* globals also remain (inline onclick="").
  window.PerlerAdmin.builder = {
    load: window.loadQuestionnaireBuilder,
    save: window.saveBuilder, publish: window.publishBuilder, copyLink: window.copyBuilderLink,
    preview: window.openBuilderPreview,
    hasUnsavedChanges: window.builderHasUnsavedChanges, currentId: window.currentBuilderId
  };
})();
