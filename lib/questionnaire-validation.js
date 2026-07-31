const crypto = require('crypto');
const { clean } = require('./validation');

// ---------- Enums ----------

const QUESTION_TYPES = [
  'short_answer', 'long_answer', 'multiple_choice', 'checkboxes', 'dropdown',
  'yes_no', 'number', 'date', 'rating_5', 'rating_10',
  'file_upload', 'image_upload', 'section_divider', 'heading'
];

// Types that render an options[] list.
const CHOICE_TYPES = ['multiple_choice', 'checkboxes', 'dropdown'];

// Layout-only types: never required, never answerable, never a condition source.
const LAYOUT_TYPES = ['section_divider', 'heading'];

// "Support conditions based on: Multiple-choice answers, Yes/No answers, Dropdown
// selections, Checkbox selections where practical" -- an admin can only build a rule
// off one of these answer shapes.
const CONDITION_SOURCE_TYPES = ['multiple_choice', 'checkboxes', 'dropdown', 'yes_no'];

const CONDITIONAL_OPERATORS = ['equals', 'notEquals', 'includes'];

const TEMPLATE_STATUSES = ['Draft', 'Published', 'Archived'];

// "Expired" is intentionally excluded here -- like invoices.js's "Overdue", it is
// never stored, only derived at read time from tokenExpiresAt (see
// lib/questionnaire-logic.js effectiveQuestionnaireStatus()).
const STORED_QUESTIONNAIRE_STATUSES = ['Draft', 'Published', 'Sent', 'Viewed', 'InProgress', 'Completed', 'Archived'];
const QUESTIONNAIRE_STATUSES = [...STORED_QUESTIONNAIRE_STATUSES, 'Expired'];

const QUESTIONNAIRE_EMAIL_TYPES = ['initial_send', 'resend', 'reminder', 'completion_notification'];

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_LABEL_LENGTH = 500;
const MAX_HELPER_TEXT_LENGTH = 1000;
const MAX_OPTION_LABEL_LENGTH = 200;
const MAX_OPTIONS_PER_QUESTION = 50;
const MAX_QUESTIONS_PER_SECTION = 100;
const MAX_SECTIONS = 50;
const MAX_ANSWER_TEXT_LENGTH = 5000;

// ---------- File upload validation ----------

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB
const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];
const ALLOWED_DOCUMENT_MIME_TYPES = [
  ...ALLOWED_IMAGE_MIME_TYPES,
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
];

// A safe extension allowlist used for the *stored* filename -- the original filename
// is kept only as metadata (originalName), never used to build a path. See
// safeStorageFilename() in api/questionnaire-responses.js.
const ALLOWED_FILE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'pdf', 'doc', 'docx', 'txt'];

function allowedMimeTypesFor(questionType) {
  return questionType === 'image_upload' ? ALLOWED_IMAGE_MIME_TYPES : ALLOWED_DOCUMENT_MIME_TYPES;
}

function generateId() {
  return crypto.randomUUID();
}

// ---------- Structural sanitization (whitelist reconstruction, never spread-and-keep) ----------

function sanitizeOption(raw) {
  const label = clean(raw?.label, MAX_OPTION_LABEL_LENGTH);
  if (!label) return null;
  return { id: (typeof raw?.id === 'string' && raw.id) || generateId(), label };
}

function sanitizeConditionalLogicShape(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const questionId = clean(raw.questionId, 100);
  const operator = clean(raw.operator, 20);
  const value = clean(raw.value, MAX_OPTION_LABEL_LENGTH);
  if (!questionId || !CONDITIONAL_OPERATORS.includes(operator) || !value) return null;
  return { questionId, operator, value };
}

// Validates + rebuilds a single question. Returns { question, errors }. Does not
// validate conditionalLogic *references* (needs the full flattened list -- see
// validateConditionalLogicReferences below); only checks its shape here.
function sanitizeQuestion(raw, sectionIndex, questionIndex) {
  const errors = [];
  const where = `Section ${sectionIndex + 1}, question ${questionIndex + 1}`;

  const type = clean(raw?.type, 30);
  if (!QUESTION_TYPES.includes(type)) {
    errors.push(`${where}: unknown question type "${type}".`);
    return { question: null, errors };
  }

  const isLayout = LAYOUT_TYPES.includes(type);
  const label = clean(raw?.label, MAX_LABEL_LENGTH);
  if (!label) {
    errors.push(`${where}: a label is required.`);
    return { question: null, errors };
  }

  const question = {
    id: (typeof raw?.id === 'string' && raw.id) || generateId(),
    type,
    label,
    helperText: isLayout ? '' : clean(raw?.helperText, MAX_HELPER_TEXT_LENGTH),
    required: isLayout ? false : Boolean(raw?.required),
    order: questionIndex,
    options: [],
    allowOther: false,
    conditionalLogic: null
  };

  if (CHOICE_TYPES.includes(type)) {
    const rawOptions = Array.isArray(raw?.options) ? raw.options.slice(0, MAX_OPTIONS_PER_QUESTION) : [];
    question.options = rawOptions.map(sanitizeOption).filter(Boolean);
    question.allowOther = Boolean(raw?.allowOther);
    if (!question.options.length) {
      errors.push(`${where}: at least one answer option is required.`);
    }
  }

  if (!isLayout) {
    question.conditionalLogic = sanitizeConditionalLogicShape(raw?.conditionalLogic);
  }

  return { question, errors };
}

function sanitizeSection(raw, sectionIndex) {
  const errors = [];
  const title = clean(raw?.title, MAX_TITLE_LENGTH);
  if (!title) errors.push(`Section ${sectionIndex + 1}: a title is required.`);

  const rawQuestions = Array.isArray(raw?.questions) ? raw.questions.slice(0, MAX_QUESTIONS_PER_SECTION) : [];
  const questions = [];
  rawQuestions.forEach((rawQuestion, questionIndex) => {
    const { question, errors: questionErrors } = sanitizeQuestion(rawQuestion, sectionIndex, questionIndex);
    errors.push(...questionErrors);
    if (question) questions.push(question);
  });

  const section = {
    id: (typeof raw?.id === 'string' && raw.id) || generateId(),
    title,
    description: clean(raw?.description, MAX_DESCRIPTION_LENGTH),
    order: sectionIndex,
    conditionalLogic: sanitizeConditionalLogicShape(raw?.conditionalLogic),
    questions
  };

  return { section, errors };
}

// Flattens sections into one ordered list of section/question nodes. Position in this
// array is used as the single source of truth for "earlier in the questionnaire" when
// validating conditional logic -- see validateConditionalLogicReferences().
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

// A question/section may only reference a question that appears strictly earlier in
// the flattened order. This makes circular dependencies impossible *by construction*
// (there is no way to build a cycle if every edge points backward), rather than
// needing a separate cycle-detection pass -- simpler code and a simpler mental model
// for the admin ("show this based on an answer given earlier in the form").
// It also naturally rejects references to deleted questions: a removed question's id
// simply no longer appears in the flattened list.
function validateConditionalLogicReferences(sections) {
  const errors = [];
  const nodes = flattenOrdered(sections);
  const questionTypeById = new Map();
  const questionPositionById = new Map();

  nodes.forEach((entry, position) => {
    if (entry.nodeType !== 'question') return;
    questionTypeById.set(entry.id, entry.node.type);
    questionPositionById.set(entry.id, position);
  });

  nodes.forEach((entry, position) => {
    const logic = entry.node.conditionalLogic;
    if (!logic) return;

    const label = entry.nodeType === 'section' ? `Section "${entry.node.title}"` : `Question "${entry.node.label}"`;

    if (logic.questionId === entry.id) {
      errors.push(`${label}: cannot depend on itself.`);
      return;
    }

    const sourceType = questionTypeById.get(logic.questionId);
    if (sourceType === undefined) {
      errors.push(`${label}: its condition refers to a question that no longer exists.`);
      return;
    }

    if (!CONDITION_SOURCE_TYPES.includes(sourceType)) {
      errors.push(`${label}: conditions can only be based on multiple choice, checkbox, dropdown, or yes/no questions.`);
      return;
    }

    const sourcePosition = questionPositionById.get(logic.questionId);
    if (sourcePosition >= position) {
      errors.push(`${label}: conditions can only depend on a question that appears earlier in the questionnaire.`);
    }

    if (logic.operator === 'includes' && sourceType !== 'checkboxes') {
      errors.push(`${label}: the "includes" condition only applies to checkbox questions.`);
    }
  });

  return errors;
}

// Top-level entry point used by both questionnaireTemplates and questionnaires
// create/update actions. Never throws -- returns { errors, title, description,
// sections } so the caller can respond with a clean 400 listing every problem found.
function sanitizeQuestionnaireContent(raw) {
  const errors = [];
  const title = clean(raw?.title, MAX_TITLE_LENGTH);
  if (!title) errors.push('A title is required.');

  const description = clean(raw?.description, MAX_DESCRIPTION_LENGTH);

  const rawSections = Array.isArray(raw?.sections) ? raw.sections.slice(0, MAX_SECTIONS) : [];
  const sections = [];
  rawSections.forEach((rawSection, sectionIndex) => {
    const { section, errors: sectionErrors } = sanitizeSection(rawSection, sectionIndex);
    errors.push(...sectionErrors);
    sections.push(section);
  });

  errors.push(...validateConditionalLogicReferences(sections));

  return { errors, title, description, sections };
}

module.exports = {
  QUESTION_TYPES,
  CHOICE_TYPES,
  LAYOUT_TYPES,
  CONDITION_SOURCE_TYPES,
  CONDITIONAL_OPERATORS,
  TEMPLATE_STATUSES,
  STORED_QUESTIONNAIRE_STATUSES,
  QUESTIONNAIRE_STATUSES,
  QUESTIONNAIRE_EMAIL_TYPES,
  MAX_ANSWER_TEXT_LENGTH,
  MAX_FILE_SIZE_BYTES,
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_DOCUMENT_MIME_TYPES,
  ALLOWED_FILE_EXTENSIONS,
  allowedMimeTypesFor,
  generateId,
  sanitizeQuestionnaireContent,
  flattenOrdered
};
