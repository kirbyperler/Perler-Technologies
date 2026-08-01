// Deterministic, dependency-free regression tests for the conditional-logic
// evaluator shared by lib/questionnaire-logic.js (server) and
// js/questionnaire-renderer.js (browser -- same algorithm, ported since that file
// can't require() this one client-side; keep both in sync if either changes).
// Run with: node scripts/test-questionnaire-logic.js
const assert = require('node:assert/strict');
const {
  computeVisibility,
  findMissingRequiredAnswers,
  computeCompletionPercentage
} = require('../lib/questionnaire-logic');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok: ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

function section(id, questions, conditionalLogic = null) {
  return { id, title: id, description: '', order: 0, conditionalLogic, questions };
}
function question(id, type, overrides = {}) {
  return { id, type, label: id, helperText: '', required: false, order: 0, options: [], allowOther: false, conditionalLogic: null, ...overrides };
}

test('yes_no equals: dependent question visible only when answer matches', () => {
  const sections = [section('s1', [
    question('q1', 'yes_no'),
    question('q2', 'short_answer', { conditionalLogic: { questionId: 'q1', operator: 'equals', value: 'Yes' } })
  ])];

  assert.equal(computeVisibility(sections, { q1: 'Yes' }).visibleQuestionIds.has('q2'), true);
  assert.equal(computeVisibility(sections, { q1: 'No' }).visibleQuestionIds.has('q2'), false);
  assert.equal(computeVisibility(sections, {}).visibleQuestionIds.has('q2'), false);
});

test('notEquals: dependent question visible only when answer differs', () => {
  const sections = [section('s1', [
    question('q1', 'multiple_choice', { options: [{ id: 'o1', label: 'Free' }, { id: 'o2', label: 'Pro' }] }),
    question('q2', 'short_answer', { conditionalLogic: { questionId: 'q1', operator: 'notEquals', value: 'Pro' } })
  ])];

  assert.equal(computeVisibility(sections, { q1: 'Free' }).visibleQuestionIds.has('q2'), true);
  assert.equal(computeVisibility(sections, { q1: 'Pro' }).visibleQuestionIds.has('q2'), false);
});

test('dropdown equals behaves the same way as multiple_choice equals', () => {
  const sections = [section('s1', [
    question('q1', 'dropdown', { options: [{ id: 'o1', label: 'US' }, { id: 'o2', label: 'Other' }] }),
    question('q2', 'short_answer', { conditionalLogic: { questionId: 'q1', operator: 'equals', value: 'US' } })
  ])];

  assert.equal(computeVisibility(sections, { q1: 'US' }).visibleQuestionIds.has('q2'), true);
  assert.equal(computeVisibility(sections, { q1: 'Other' }).visibleQuestionIds.has('q2'), false);
});

test('checkboxes includes: dependent question visible only when the array contains the value', () => {
  const sections = [section('s1', [
    question('q1', 'checkboxes', { options: [{ id: 'o1', label: 'Web' }, { id: 'o2', label: 'Consulting' }] }),
    question('q2', 'short_answer', { conditionalLogic: { questionId: 'q1', operator: 'includes', value: 'Consulting' } })
  ])];

  assert.equal(computeVisibility(sections, { q1: ['Web'] }).visibleQuestionIds.has('q2'), false);
  assert.equal(computeVisibility(sections, { q1: ['Web', 'Consulting'] }).visibleQuestionIds.has('q2'), true);
  assert.equal(computeVisibility(sections, { q1: [] }).visibleQuestionIds.has('q2'), false);
  assert.equal(computeVisibility(sections, {}).visibleQuestionIds.has('q2'), false);
});

test('a hidden required question never blocks submission (findMissingRequiredAnswers)', () => {
  const sections = [section('s1', [
    question('q1', 'yes_no', { required: true }),
    question('q2', 'short_answer', { required: true, conditionalLogic: { questionId: 'q1', operator: 'equals', value: 'Yes' } })
  ])];

  assert.deepEqual(findMissingRequiredAnswers(sections, { q1: 'No' }), []);
  assert.deepEqual(findMissingRequiredAnswers(sections, { q1: 'Yes' }), ['q2']);
  assert.deepEqual(findMissingRequiredAnswers(sections, { q1: 'Yes', q2: 'Card' }), []);
});

test('a hidden question never counts toward completion percentage', () => {
  const sections = [section('s1', [
    question('q1', 'yes_no', { required: true }),
    question('q2', 'short_answer', { required: true, conditionalLogic: { questionId: 'q1', operator: 'equals', value: 'Yes' } })
  ])];

  // q1=No hides q2 -- the only *visible* required question is q1, and it's answered.
  assert.equal(computeCompletionPercentage(sections, { q1: 'No' }), 100);
});

test('chained conditions: a section gated on q1, a question inside it gated on q2', () => {
  const sections = [
    section('s0', [question('q1', 'yes_no')]),
    section('s1', [
      question('q2', 'yes_no', { conditionalLogic: { questionId: 'q1', operator: 'equals', value: 'Yes' } }),
      question('q3', 'short_answer', { conditionalLogic: { questionId: 'q2', operator: 'equals', value: 'Yes' } })
    ], { questionId: 'q1', operator: 'equals', value: 'Yes' })
  ];

  // q1=No -> section s1 itself is hidden, so q2/q3 are both hidden regardless of their own answers.
  let visible = computeVisibility(sections, { q1: 'No', q2: 'Yes', q3: 'anything' });
  assert.equal(visible.visibleSectionIds.has('s1'), false);
  assert.equal(visible.visibleQuestionIds.has('q2'), false);
  assert.equal(visible.visibleQuestionIds.has('q3'), false);

  // q1=Yes -> section visible, q2 visible; q3 depends on q2.
  visible = computeVisibility(sections, { q1: 'Yes', q2: 'No' });
  assert.equal(visible.visibleQuestionIds.has('q2'), true);
  assert.equal(visible.visibleQuestionIds.has('q3'), false);

  visible = computeVisibility(sections, { q1: 'Yes', q2: 'Yes' });
  assert.equal(visible.visibleQuestionIds.has('q3'), true);
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
