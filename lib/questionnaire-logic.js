const { clean } = require('./validation');
const { flattenOrdered, LAYOUT_TYPES, MAX_ANSWER_TEXT_LENGTH } = require('./questionnaire-validation');

// answers is always a plain object keyed by questionId -> value. The shape of value
// depends on the question type (see normalizeAnswerValue below).

function isConditionSatisfied(logic, answers) {
  if (!logic) return true;
  const answer = answers?.[logic.questionId];
  if (logic.operator === 'includes') {
    return Array.isArray(answer) && answer.includes(logic.value);
  }
  const matches = String(answer ?? '') === logic.value;
  return logic.operator === 'notEquals' ? !matches : matches;
}

// Single forward pass is sufficient (rather than iterating to a fixed point) because
// lib/questionnaire-validation.js guarantees every condition points to a strictly
// earlier question -- by the time a node's own condition is evaluated, its source
// question's visibility has already been resolved earlier in this same loop.
function computeVisibility(sections, answers) {
  const nodes = flattenOrdered(sections);
  const visibleSectionIds = new Set();
  const visibleQuestionIds = new Set();

  for (const entry of nodes) {
    const logic = entry.node.conditionalLogic;
    const logicSatisfied = !logic || (visibleQuestionIds.has(logic.questionId) && isConditionSatisfied(logic, answers));

    if (entry.nodeType === 'section') {
      if (logicSatisfied) visibleSectionIds.add(entry.id);
    } else {
      const sectionVisible = visibleSectionIds.has(entry.sectionId);
      if (sectionVisible && logicSatisfied) visibleQuestionIds.add(entry.id);
    }
  }

  return { visibleSectionIds, visibleQuestionIds };
}

function hasAnswer(question, value) {
  if (value === null || value === undefined) return false;
  if (question.type === 'checkboxes') return Array.isArray(value) && value.length > 0;
  if (question.type === 'file_upload' || question.type === 'image_upload') return Boolean(value?.fileId);
  return String(value).trim().length > 0;
}

// Coerces + validates a single raw answer against its question's type. Returns null
// (never the raw value) when the input doesn't fit the type, so a malformed or
// hostile payload can never be persisted as-is -- the client-side form is never
// trusted, per the questionnaire's security requirements.
function normalizeAnswerValue(question, rawValue) {
  switch (question.type) {
    case 'short_answer':
      return clean(rawValue, 500) || null;
    case 'long_answer':
      return clean(rawValue, MAX_ANSWER_TEXT_LENGTH) || null;
    case 'number': {
      const num = Number(rawValue);
      return Number.isFinite(num) ? num : null;
    }
    case 'date': {
      if (!rawValue) return null;
      const date = new Date(rawValue);
      return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
    }
    case 'rating_5': {
      const num = Math.round(Number(rawValue));
      return Number.isFinite(num) && num >= 1 && num <= 5 ? num : null;
    }
    case 'rating_10': {
      const num = Math.round(Number(rawValue));
      return Number.isFinite(num) && num >= 1 && num <= 10 ? num : null;
    }
    case 'yes_no': {
      const value = clean(rawValue, 10);
      return ['Yes', 'No'].includes(value) ? value : null;
    }
    case 'dropdown':
    case 'multiple_choice': {
      const value = clean(rawValue, 200);
      if (!value) return null;
      const isKnownOption = question.options.some(option => option.label === value);
      return isKnownOption || question.allowOther ? value : null;
    }
    case 'checkboxes': {
      const rawArray = Array.isArray(rawValue) ? rawValue.slice(0, 50) : [];
      const cleaned = rawArray.map(item => clean(item, 200)).filter(Boolean);
      if (question.allowOther) return cleaned;
      return cleaned.filter(item => question.options.some(option => option.label === item));
    }
    case 'file_upload':
    case 'image_upload': {
      // Expected shape produced by api/questionnaire-responses.js's uploadFile
      // action: { fileId, originalName, size, url }. Never accept a client-invented
      // URL -- only a fileId that traces back to a real questionnaireFiles record
      // uploaded through that action.
      if (!rawValue || typeof rawValue !== 'object' || typeof rawValue.fileId !== 'string') return null;
      return {
        fileId: clean(rawValue.fileId, 100),
        originalName: clean(rawValue.originalName, 300),
        size: Number.isFinite(Number(rawValue.size)) ? Number(rawValue.size) : 0,
        url: clean(rawValue.url, 1000)
      };
    }
    default:
      return null;
  }
}

// Rebuilds a clean answers map from a raw client payload: drops any key that isn't a
// real, non-layout question id in this questionnaire, and coerces every value through
// normalizeAnswerValue. A rejected/empty value is omitted entirely rather than stored
// as null, so hasAnswer() stays a simple presence check.
function normalizeAnswers(sections, rawAnswers) {
  const questionsById = new Map(
    flattenOrdered(sections)
      .filter(entry => entry.nodeType === 'question' && !LAYOUT_TYPES.includes(entry.node.type))
      .map(entry => [entry.id, entry.node])
  );

  const cleaned = {};
  if (rawAnswers && typeof rawAnswers === 'object') {
    for (const [questionId, rawValue] of Object.entries(rawAnswers)) {
      const question = questionsById.get(questionId);
      if (!question) continue;
      const value = normalizeAnswerValue(question, rawValue);
      if (value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)) {
        cleaned[questionId] = value;
      }
    }
  }
  return cleaned;
}

function computeCompletionPercentage(sections, answers) {
  const { visibleQuestionIds } = computeVisibility(sections, answers);
  const questions = flattenOrdered(sections)
    .filter(entry => entry.nodeType === 'question' && !LAYOUT_TYPES.includes(entry.node.type) && visibleQuestionIds.has(entry.id));

  if (!questions.length) return 0;

  const required = questions.filter(entry => entry.node.required);
  const pool = required.length ? required : questions;
  const answeredCount = pool.filter(entry => hasAnswer(entry.node, answers[entry.id])).length;
  return Math.round((answeredCount / pool.length) * 100);
}

function findMissingRequiredAnswers(sections, answers) {
  const { visibleQuestionIds } = computeVisibility(sections, answers);
  return flattenOrdered(sections)
    .filter(entry => entry.nodeType === 'question' && visibleQuestionIds.has(entry.id) && entry.node.required && !hasAnswer(entry.node, answers[entry.id]))
    .map(entry => entry.id);
}

// Required questions the respondent was never shown because a condition hid them --
// surfaced on the admin response-review screen as "skipped due to conditional logic"
// rather than being confused with questions the respondent simply left blank.
function findSkippedQuestions(sections, answers) {
  const { visibleQuestionIds } = computeVisibility(sections, answers);
  return flattenOrdered(sections)
    .filter(entry => entry.nodeType === 'question' && !LAYOUT_TYPES.includes(entry.node.type) && !visibleQuestionIds.has(entry.id))
    .map(entry => entry.id);
}

module.exports = {
  computeVisibility,
  hasAnswer,
  normalizeAnswerValue,
  normalizeAnswers,
  computeCompletionPercentage,
  findMissingRequiredAnswers,
  findSkippedQuestions
};
