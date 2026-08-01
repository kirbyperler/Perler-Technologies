// Generic sectioned-form rendering engine: given a { sections: [{ questions: [...] }] }
// document and an in-progress answers map, evaluates conditional show/hide logic and
// renders one section at a time with a progress bar. Nothing here is specific to
// "questionnaires" -- the same shape works for any structured form (intake forms,
// applications, registrations, onboarding, internal forms), so new form types only
// ever need their own thin wrapper around renderQuestionnaireRunner(), never a copy
// of the rendering/visibility logic itself.
//
// Used by both the admin builder's Preview modal (config.isPreview: true) and the
// public respondent page at /questionnaire/:token (js/questionnaire-respond.js). The
// visibility algorithm mirrors
// lib/questionnaire-logic.js's computeVisibility() (ported to the browser since that
// module can't be required() client-side) -- keep the two in sync if either changes.
(() => {
  // Falls back to a real escaper (not just String()) when window.PerlerAdmin isn't
  // present -- the public respondent page doesn't load admin.js, and this renderer
  // interpolates respondent-entered values (e.g. a saved short-answer draft) back into
  // innerHTML on reload, so an identity fallback would be an XSS hole there.
  const escapeHtml = window.PerlerAdmin?.format?.escapeHtml || (value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[char])));

  function isConditionSatisfied(logic, answers) {
    if (!logic) return true;
    const answer = answers?.[logic.questionId];
    if (logic.operator === 'includes') return Array.isArray(answer) && answer.includes(logic.value);
    const matches = String(answer ?? '') === logic.value;
    return logic.operator === 'notEquals' ? !matches : matches;
  }

  function flattenOrdered(sections) {
    const nodes = [];
    (sections || []).forEach(section => {
      nodes.push({ nodeType: 'section', id: section.id, node: section });
      (section.questions || []).forEach(question => {
        nodes.push({ nodeType: 'question', id: question.id, sectionId: section.id, node: question });
      });
    });
    return nodes;
  }

  function computeVisibility(sections, answers) {
    const nodes = flattenOrdered(sections);
    const visibleSectionIds = new Set();
    const visibleQuestionIds = new Set();
    for (const entry of nodes) {
      const logic = entry.node.conditionalLogic;
      const logicSatisfied = !logic || (visibleQuestionIds.has(logic.questionId) && isConditionSatisfied(logic, answers));
      if (entry.nodeType === 'section') {
        if (logicSatisfied) visibleSectionIds.add(entry.id);
      } else if (visibleSectionIds.has(entry.sectionId) && logicSatisfied) {
        visibleQuestionIds.add(entry.id);
      }
    }
    return { visibleSectionIds, visibleQuestionIds };
  }

  const LAYOUT_TYPES = ['section_divider', 'heading'];
  const FILE_TYPES = ['file_upload', 'image_upload'];

  function hasAnswer(question, value) {
    if (value === null || value === undefined) return false;
    if (question.type === 'checkboxes') return Array.isArray(value) && value.length > 0;
    if (question.type === 'file_upload' || question.type === 'image_upload') return Boolean(value?.fileId);
    return String(value).trim().length > 0;
  }

  function computeCompletionPercentage(sections, answers) {
    const { visibleQuestionIds } = computeVisibility(sections, answers);
    const questions = flattenOrdered(sections).filter(e => e.nodeType === 'question' && !LAYOUT_TYPES.includes(e.node.type) && visibleQuestionIds.has(e.id));
    if (!questions.length) return 0;
    const required = questions.filter(e => e.node.required);
    const pool = required.length ? required : questions;
    return Math.round((pool.filter(e => hasAnswer(e.node, answers[e.id])).length / pool.length) * 100);
  }

  function findMissingRequiredAnswers(sections, answers) {
    const { visibleQuestionIds } = computeVisibility(sections, answers);
    return flattenOrdered(sections)
      .filter(e => e.nodeType === 'question' && visibleQuestionIds.has(e.id) && e.node.required && !hasAnswer(e.node, answers[e.id]))
      .map(e => e.id);
  }

  function fieldHtml(question, value, readOnly, isPreview) {
    const id = `q-${question.id}`;
    const disabled = readOnly ? 'disabled' : '';
    switch (question.type) {
      case 'short_answer':
        return `<input class="preview-input" id="${id}" type="text" value="${escapeHtml(value || '')}" data-answer-field ${disabled}>`;
      case 'long_answer':
        return `<textarea class="preview-input" id="${id}" rows="4" data-answer-field ${disabled}>${escapeHtml(value || '')}</textarea>`;
      case 'number':
        return `<input class="preview-input" id="${id}" type="number" value="${value ?? ''}" data-answer-field ${disabled}>`;
      case 'date':
        return `<input class="preview-input" id="${id}" type="date" value="${value || ''}" data-answer-field ${disabled}>`;
      case 'yes_no':
        return ['Yes', 'No'].map(opt => `
          <label class="preview-option-row"><input type="radio" name="${id}" value="${opt}" data-answer-field ${value === opt ? 'checked' : ''} ${disabled}> ${opt}</label>
        `).join('');
      case 'dropdown': {
        const options = (question.options || []).map(o => `<option value="${escapeHtml(o.label)}" ${value === o.label ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
        const otherOpt = question.allowOther ? `<option value="__other__" ${value && !question.options.some(o => o.label === value) ? 'selected' : ''}>Other</option>` : '';
        return `<div class="select-wrap"><select class="preview-input" id="${id}" data-answer-field ${disabled}><option value="">Select an answer</option>${options}${otherOpt}</select></div>`;
      }
      case 'multiple_choice': {
        const rows = (question.options || []).map(o => `
          <label class="preview-option-row"><input type="radio" name="${id}" value="${escapeHtml(o.label)}" data-answer-field ${value === o.label ? 'checked' : ''} ${disabled}> ${escapeHtml(o.label)}</label>
        `).join('');
        const other = question.allowOther ? `<label class="preview-option-row"><input type="radio" name="${id}" value="__other__" data-answer-field ${disabled}> Other</label>` : '';
        return rows + other;
      }
      case 'checkboxes': {
        const selected = Array.isArray(value) ? value : [];
        const rows = (question.options || []).map(o => `
          <label class="preview-option-row"><input type="checkbox" value="${escapeHtml(o.label)}" data-answer-field ${selected.includes(o.label) ? 'checked' : ''} ${disabled}> ${escapeHtml(o.label)}</label>
        `).join('');
        const other = question.allowOther ? `<label class="preview-option-row"><input type="checkbox" value="__other__" data-answer-field ${disabled}> Other</label>` : '';
        return rows + other;
      }
      case 'rating_5':
      case 'rating_10': {
        const max = question.type === 'rating_5' ? 5 : 10;
        const buttons = Array.from({ length: max }, (_, i) => i + 1)
          .map(n => `<button type="button" class="preview-rating-option${Number(value) === n ? ' selected' : ''}" data-rating-value="${n}" ${disabled}>${n}</button>`)
          .join('');
        return `<div class="preview-rating-row" id="${id}">${buttons}</div>`;
      }
      case 'file_upload':
      case 'image_upload': {
        // Only the admin builder's Preview modal passes isPreview: true -- everywhere
        // else (the live respondent page) renders a real upload control instead,
        // wired up via config.onFileUpload in renderQuestionnaireRunner() below.
        if (isPreview) {
          return `<p class="field-hint">File upload isn't available in preview mode -- it will be available on the live respondent page.</p>`;
        }
        const currentName = value?.fileId ? escapeHtml(value.originalName || 'Uploaded file') : '';
        // Client-side hint only -- mirrors lib/questionnaire-validation.js's
        // allowedMimeTypesFor(), which is the actual enforcement point server-side.
        const accept = question.type === 'image_upload' ? 'image/*' : 'image/*,.pdf,.doc,.docx,.txt';
        return `
          <div class="file-upload-field">
            <label class="button button-secondary file-upload-button" for="${id}">${currentName ? 'Replace file' : 'Choose file'}</label>
            <input type="file" class="sr-only" id="${id}" accept="${accept}" data-file-field ${disabled}>
            <span class="file-upload-name" data-file-name>${currentName}</span>
            <p class="file-upload-status" data-file-status hidden></p>
          </div>
        `;
      }
      default:
        return '';
    }
  }

  // Reads the current DOM value for one answer-bearing question back out of the
  // rendered fields (used after every input event to keep the in-memory answers
  // object in sync).
  function readFieldValue(question, container) {
    const id = `q-${question.id}`;
    switch (question.type) {
      case 'short_answer':
      case 'long_answer':
      case 'date':
        return container.querySelector(`#${CSS.escape(id)}`)?.value || null;
      case 'number': {
        const raw = container.querySelector(`#${CSS.escape(id)}`)?.value;
        return raw === '' || raw == null ? null : Number(raw);
      }
      case 'yes_no':
      case 'multiple_choice':
        return container.querySelector(`input[name="${CSS.escape(id)}"]:checked`)?.value || null;
      case 'dropdown':
        return container.querySelector(`#${CSS.escape(id)}`)?.value || null;
      case 'checkboxes':
        return Array.from(container.querySelectorAll(`.preview-question[data-question-id="${question.id}"] input[type="checkbox"]:checked`)).map(el => el.value);
      case 'rating_5':
      case 'rating_10':
        return container.querySelector(`#${CSS.escape(id)} .preview-rating-option.selected`)?.dataset.ratingValue
          ? Number(container.querySelector(`#${CSS.escape(id)} .preview-rating-option.selected`).dataset.ratingValue)
          : null;
      default:
        return null;
    }
  }

  // Renders a questionnaire one visible section at a time with a progress bar,
  // Back/Next, and required-field validation. `config`:
  //   answers, currentSectionId: initial state
  //   readOnly: render fields disabled (used nowhere yet, reserved for read-only review)
  //   isPreview: true only in the admin builder's Preview modal -- shows a "not
  //     available in preview" message for file_upload/image_upload instead of a real
  //     upload control
  //   onFileUpload(file, question) -- required whenever a file_upload/image_upload
  //     question can be visible and isPreview isn't set; must return a promise
  //     resolving to { fileId, originalName, size, url }
  //   onAnswerChange(answers, completionPercentage)
  //   onSectionChange(sectionId)
  //   onSubmit(answers) -- called only after required-field validation passes on the
  //     final visible section; the caller decides what "submit" means (preview just
  //     shows a confirmation, Phase 4's respondent page will POST to the real API).
  function renderQuestionnaireRunner(container, questionnaire, config = {}) {
    const sections = questionnaire.sections || [];
    let answers = { ...(config.answers || {}) };
    let currentSectionId = config.currentSectionId || null;
    let submitted = false;

    function visibleSections() {
      const { visibleSectionIds } = computeVisibility(sections, answers);
      return sections.filter(s => visibleSectionIds.has(s.id));
    }

    function currentIndex(list) {
      const idx = list.findIndex(s => s.id === currentSectionId);
      return idx === -1 ? 0 : idx;
    }

    function updateProgressBar() {
      const fill = container.querySelector('.preview-progress-fill');
      if (fill) fill.style.width = `${computeCompletionPercentage(sections, answers)}%`;
    }

    // Toggles which already-rendered question nodes are hidden, without rebuilding
    // any DOM -- so a condition becoming newly true/false reacts immediately (root
    // cause fix for "visibility doesn't update until Next/Back") without stealing
    // focus from whatever field the respondent is currently typing in. Every
    // question in the section is always present in the DOM (see render() below);
    // only its `hidden` attribute changes here.
    function refreshVisibility(questionsList) {
      const { visibleQuestionIds } = computeVisibility(sections, answers);
      questionsList.forEach(question => {
        const node = container.querySelector(`[data-question-id="${question.id}"]`);
        if (node) node.hidden = !visibleQuestionIds.has(question.id);
      });
      updateProgressBar();
    }

    function syncSection(questionsList) {
      questionsList.forEach(question => {
        // File questions are skipped here, not just left with no readFieldValue case:
        // this function re-reads every question in the section on every keystroke, and
        // a file answer is set asynchronously by the upload handler (see
        // container.querySelectorAll('[data-file-field]') below), not by reading the
        // DOM synchronously -- reading it here would overwrite an already-uploaded
        // file's answer back to null the next time the respondent edits any other
        // field in the same section.
        if (LAYOUT_TYPES.includes(question.type) || FILE_TYPES.includes(question.type)) return;
        const value = readFieldValue(question, container);
        answers = { ...answers, [question.id]: value };
      });
      config.onAnswerChange?.(answers, computeCompletionPercentage(sections, answers));
      refreshVisibility(questionsList);
    }

    function render() {
      const list = visibleSections();
      if (!list.length) {
        container.innerHTML = `<p class="empty-state-inline">This questionnaire has no questions yet.</p>`;
        return;
      }
      let index = currentIndex(list);
      if (index >= list.length) index = list.length - 1;
      const section = list[index];
      currentSectionId = section.id;

      const { visibleQuestionIds } = computeVisibility(sections, answers);
      const percent = computeCompletionPercentage(sections, answers);
      // Every question is rendered (not just currently-visible ones) so
      // refreshVisibility() can reveal/hide them by toggling `hidden` instead of
      // needing to rebuild the section's HTML on every keystroke.
      const allQuestions = section.questions || [];

      const questionsHtml = allQuestions.map(question => {
        const hiddenAttr = visibleQuestionIds.has(question.id) ? '' : 'hidden';
        if (question.type === 'heading') return `<p class="preview-heading" data-question-id="${question.id}" ${hiddenAttr}>${escapeHtml(question.label)}</p>`;
        if (question.type === 'section_divider') return `<div class="preview-divider" data-question-id="${question.id}" ${hiddenAttr}></div>`;
        return `
          <div class="preview-question" data-question-id="${question.id}" ${hiddenAttr}>
            <label>${escapeHtml(question.label)}${question.required ? ' *' : ''}</label>
            ${question.helperText ? `<p class="field-hint">${escapeHtml(question.helperText)}</p>` : ''}
            ${fieldHtml(question, answers[question.id], Boolean(config.readOnly), Boolean(config.isPreview))}
            <p class="preview-error hidden" data-error-for="${question.id}"></p>
          </div>
        `;
      }).join('');

      const isLast = index === list.length - 1;

      container.innerHTML = `
        <div class="preview-progress-track"><div class="preview-progress-fill" style="width:${percent}%"></div></div>
        <h3 class="preview-section-title">${escapeHtml(section.title)}</h3>
        ${section.description ? `<p class="preview-section-description">${escapeHtml(section.description)}</p>` : ''}
        ${questionsHtml || '<p class="empty-state-inline">No questions in this section.</p>'}
        <div class="preview-nav">
          <button type="button" class="button button-secondary" id="preview-back-button" ${index === 0 ? 'disabled' : ''}>Back</button>
          <button type="button" class="button button-primary" id="preview-next-button">${isLast ? (config.submitLabel || 'Submit') : 'Next'}</button>
        </div>
      `;

      container.querySelectorAll('[data-answer-field]').forEach(el => {
        el.addEventListener('input', () => syncSection(allQuestions));
        el.addEventListener('change', () => syncSection(allQuestions));
      });
      // File inputs are handled separately from the [data-answer-field] wiring above:
      // the answer isn't available synchronously (it comes back from
      // config.onFileUpload, an async network call), so it's written into `answers`
      // directly here rather than read back off the DOM by readFieldValue().
      container.querySelectorAll('[data-file-field]').forEach(input => {
        input.addEventListener('change', async () => {
          const file = input.files[0];
          if (!file) return;
          const questionId = input.closest('.preview-question')?.dataset.questionId;
          const question = allQuestions.find(q => q.id === questionId);
          const wrapper = input.closest('.file-upload-field');
          const nameEl = wrapper.querySelector('[data-file-name]');
          const statusEl = wrapper.querySelector('[data-file-status]');
          if (!question) return;

          input.disabled = true;
          statusEl.hidden = false;
          statusEl.classList.remove('is-error');
          statusEl.textContent = 'Uploading…';
          try {
            const result = await config.onFileUpload?.(file, question);
            if (!result?.fileId) throw new Error('File upload is not available.');
            answers = { ...answers, [question.id]: result };
            nameEl.textContent = result.originalName || 'Uploaded file';
            wrapper.querySelector('.file-upload-button').textContent = 'Replace file';
            statusEl.hidden = true;
            config.onAnswerChange?.(answers, computeCompletionPercentage(sections, answers));
            refreshVisibility(allQuestions);
          } catch (error) {
            statusEl.classList.add('is-error');
            statusEl.textContent = error.message || 'The file could not be uploaded.';
          } finally {
            input.disabled = false;
            input.value = '';
          }
        });
      });

      container.querySelectorAll('.preview-rating-option').forEach(button => {
        button.addEventListener('click', () => {
          const questionId = button.closest('.preview-question').dataset.questionId;
          answers = { ...answers, [questionId]: Number(button.dataset.ratingValue) };
          button.parentElement.querySelectorAll('.preview-rating-option').forEach(b => b.classList.toggle('selected', b === button));
          config.onAnswerChange?.(answers, computeCompletionPercentage(sections, answers));
          refreshVisibility(allQuestions);
        });
      });

      document.getElementById('preview-back-button')?.addEventListener('click', () => {
        if (index > 0) { currentSectionId = list[index - 1].id; config.onSectionChange?.(currentSectionId); render(); }
      });
      document.getElementById('preview-next-button')?.addEventListener('click', () => {
        const { visibleQuestionIds: currentlyVisible } = computeVisibility(sections, answers);
        const missing = allQuestions.filter(q => currentlyVisible.has(q.id) && !LAYOUT_TYPES.includes(q.type) && q.required && !hasAnswer(q, answers[q.id]));
        container.querySelectorAll('[data-error-for]').forEach(el => el.classList.add('hidden'));
        if (missing.length) {
          missing.forEach(q => {
            const el = container.querySelector(`[data-error-for="${q.id}"]`);
            if (el) { el.textContent = 'This question is required.'; el.classList.remove('hidden'); }
          });
          return;
        }
        if (isLast) {
          submitted = true;
          config.onSubmit?.(answers);
          return;
        }
        currentSectionId = list[index + 1].id;
        config.onSectionChange?.(currentSectionId);
        render();
      });
    }

    render();
    return { getAnswers: () => answers, isSubmitted: () => submitted };
  }

  window.FormRenderer = {
    computeVisibility,
    computeCompletionPercentage,
    findMissingRequiredAnswers,
    flattenOrdered,
    renderQuestionnaireRunner
  };
  // Back-compat alias -- js/questionnaire-builder.js now reads window.FormRenderer.
  window.QuestionnaireRenderer = window.FormRenderer;
})();
