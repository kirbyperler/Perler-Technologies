// Public respondent page (Phase 4). Loads a questionnaire by its secure token, renders
// it with the shared js/questionnaire-renderer.js runner (same conditional-logic
// evaluator used by the admin builder's Preview), autosaves progress, and submits.
// No admin session is used or required anywhere in this file.
(() => {
  const states = {
    loading: document.getElementById('state-loading'),
    error: document.getElementById('state-error'),
    unavailable: document.getElementById('state-unavailable'),
    submitted: document.getElementById('state-submitted'),
    form: document.getElementById('state-form')
  };

  const AUTOSAVE_DEBOUNCE_MS = 900;

  let currentToken = null;
  let autosaveTimer = null;
  let autosaveInFlight = false;
  let autosaveQueuedAnswers = null;

  function showState(name) {
    Object.entries(states).forEach(([key, el]) => { if (el) el.hidden = key !== name; });
  }

  // Mirrors js/pay.js's extractToken(): reads only the path segment after
  // /questionnaire/, rejects anything outside the plain token alphabet before any
  // network request is made.
  function extractToken() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'questionnaire' || !segments[1]) return null;

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

  function setAutosaveStatus(text) {
    const el = document.getElementById('autosave-status');
    if (el) el.textContent = text;
  }

  function showFormError(message) {
    const el = document.getElementById('form-error');
    if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = message;
  }

  async function fetchJson(url, options = {}) {
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        ...options
      });
      const data = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, data };
    } catch {
      return { ok: false, status: 0, data: {} };
    }
  }

  function persistAnswers(answers, currentSectionId) {
    if (autosaveInFlight) { autosaveQueuedAnswers = { answers, currentSectionId }; return; }
    autosaveInFlight = true;
    setAutosaveStatus('Saving…');

    fetchJson('/api/questionnaire-responses?action=autosave', {
      method: 'POST',
      body: JSON.stringify({ token: currentToken, answers, currentSectionId })
    }).then(result => {
      autosaveInFlight = false;
      if (result.ok) {
        setAutosaveStatus('Saved');
      } else if (result.status === 409) {
        setAutosaveStatus('');
        showFormError(result.data.error || 'This questionnaire can no longer be edited.');
      } else {
        setAutosaveStatus('Could not save just now -- your answers are still on this page.');
      }
      if (autosaveQueuedAnswers) {
        const next = autosaveQueuedAnswers;
        autosaveQueuedAnswers = null;
        persistAnswers(next.answers, next.currentSectionId);
      }
    });
  }

  function scheduleAutosave(answers, currentSectionId) {
    clearTimeout(autosaveTimer);
    setAutosaveStatus('Unsaved changes…');
    autosaveTimer = setTimeout(() => persistAnswers(answers, currentSectionId), AUTOSAVE_DEBOUNCE_MS);
  }

  function flushAutosave(answers, currentSectionId) {
    clearTimeout(autosaveTimer);
    persistAnswers(answers, currentSectionId);
  }

  async function submitAnswers(answers) {
    showFormError(null);
    const result = await fetchJson('/api/questionnaire-responses?action=submit', {
      method: 'POST',
      body: JSON.stringify({ token: currentToken, answers })
    });

    if (result.ok) {
      setText('submitted-heading', 'Thank you -- your questionnaire has been submitted.');
      showState('submitted');
      return;
    }

    if (result.status === 400 && Array.isArray(result.data.missingQuestionIds)) {
      showFormError(result.data.error || 'Please answer all required questions before submitting.');
      return;
    }
    if (result.status === 409) {
      setText('submitted-heading', 'This questionnaire has already been submitted.');
      showState('submitted');
      return;
    }
    showFormError(result.data.error || 'The questionnaire could not be submitted. Please try again.');
  }

  function renderForm(questionnaire, response) {
    setText('questionnaire-heading', questionnaire.title || 'Questionnaire');
    const descriptionEl = document.getElementById('questionnaire-description');
    if (descriptionEl) {
      descriptionEl.textContent = questionnaire.description || '';
      descriptionEl.hidden = !questionnaire.description;
    }

    // renderQuestionnaireRunner's onAnswerChange(answers, percent) doesn't include the
    // current section id, and onSectionChange(sectionId) doesn't include answers -- so
    // the current section is tracked here and merged in on every autosave.
    let trackedSectionId = response.currentSectionId || null;

    const container = document.getElementById('questionnaire-runner');
    const runner = window.FormRenderer.renderQuestionnaireRunner(container, questionnaire, {
      answers: response.answers || {},
      currentSectionId: response.currentSectionId || null,
      submitLabel: 'Submit',
      onAnswerChange: answers => scheduleAutosave(answers, trackedSectionId),
      onSectionChange: sectionId => { trackedSectionId = sectionId; flushAutosave(runner.getAnswers(), trackedSectionId); },
      onSubmit: answers => { flushAutosave(answers, trackedSectionId); submitAnswers(answers); }
    });

    showState('form');
  }

  async function loadQuestionnaire() {
    const token = extractToken();
    if (!token) {
      setText('unavailable-heading', "This questionnaire link isn't available.");
      setText('unavailable-message', 'Please check the link and try again, or contact Perler Technologies for a new one.');
      showState('unavailable');
      return;
    }
    currentToken = token;

    const result = await fetchJson(`/api/questionnaire-responses?action=respondGet&token=${encodeURIComponent(token)}`);

    if (!result.ok) {
      if (result.status === 404 || result.status === 410) {
        setText('unavailable-heading', "This questionnaire link isn't available.");
        setText('unavailable-message', result.data.error || 'Please contact Perler Technologies if you believe this is an error, at kirby@perlertechnologies.com.');
        showState('unavailable');
        return;
      }
      showState('error');
      return;
    }

    const { questionnaire, response } = result.data;
    if (response?.submittedAt || questionnaire.status === 'Completed') {
      setText('submitted-heading', 'This questionnaire has already been submitted.');
      showState('submitted');
      return;
    }

    renderForm(questionnaire, response || {});
  }

  loadQuestionnaire();
})();
