// Shared email sending, extracted from the raw Resend HTTP call already used in
// api/inquiry.js (that file is left untouched -- this is the new reusable version
// everything questionnaire-related builds on, matching the same provider/pattern
// rather than adding a different email service).

const { resolveSiteBase, questionnaireLink } = require('./site-url');

const ADMIN_NOTIFICATION_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL || 'kirby@perlertechnologies.com';
const RESEND_FROM = process.env.INQUIRY_FROM_EMAIL || 'Perler Technologies <onboarding@resend.dev>';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// Low-level send. Never throws -- returns { success, error } so a failed email never
// takes down the request that triggered it (e.g. a submission should still save even
// if the completion-notification email fails to send).
async function sendResendEmail({ to, subject, html, replyTo }) {
  if (!process.env.RESEND_API_KEY) {
    console.error('Missing RESEND_API_KEY environment variable.');
    return { success: false, error: 'Email delivery has not been configured yet.' };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: Array.isArray(to) ? to : [to],
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        html
      })
    });

    if (!response.ok) {
      const details = await response.text();
      console.error('Resend error:', response.status, details);
      return { success: false, error: 'The email could not be delivered right now.' };
    }

    return { success: true };
  } catch (error) {
    console.error('Email send error:', error.message);
    return { success: false, error: 'The email could not be delivered right now.' };
  }
}

// Same visual language as the rest of the site (navy header, blue accent) kept in
// inline styles + Arial, since email clients don't reliably load the Google Fonts
// used elsewhere on the site -- matches the plain-Arial approach already used in
// api/inquiry.js's admin notification email.
function brandedEmailShell(bodyHtml) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;color:#0c1d37;">
      <div style="background:#051225;padding:28px 32px;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.02em;">Perler Technologies</span>
      </div>
      <div style="padding:32px;line-height:1.6;">
        ${bodyHtml}
      </div>
      <div style="padding:20px 32px;border-top:1px solid #dce5f0;color:#5e6d82;font-size:12px;">
        Perler Technologies &middot; <a href="mailto:kirby@perlertechnologies.com" style="color:#1769ff;">kirby@perlertechnologies.com</a>
      </div>
    </div>
  `;
}

async function logQuestionnaireEmail(db, { questionnaireId, type, recipientEmail, customMessage, success, error }) {
  await db.collection('questionnaireEmailLog').insertOne({
    questionnaireId,
    type,
    recipientEmail,
    customMessage: customMessage || null,
    success,
    error: error || null,
    sentAt: new Date()
  });
}

// type is one of 'initial_send' | 'resend' | 'reminder' (never 'completion_notification'
// -- see sendCompletionNotificationEmail for that one). Always writes a
// questionnaireEmailLog row, whether or not the send itself succeeded, so failed
// deliveries are visible to the admin too.
async function sendQuestionnaireInviteEmail(db, { questionnaire, recipientEmail, customMessage, type, req }) {
  const link = questionnaireLink(questionnaire.accessToken, req);

  const intro = type === 'reminder'
    ? `This is a friendly reminder to complete the <strong>${escapeHtml(questionnaire.title)}</strong> questionnaire for Perler Technologies.`
    : `Perler Technologies has sent you a questionnaire to complete: <strong>${escapeHtml(questionnaire.title)}</strong>.`;

  const bodyHtml = `
    <p style="margin:0 0 18px;">${intro}</p>
    ${questionnaire.description ? `<p style="margin:0 0 18px;color:#5e6d82;">${escapeHtml(questionnaire.description)}</p>` : ''}
    ${customMessage ? `<div style="margin:0 0 24px;padding:16px;border-radius:10px;background:#f5f8fc;white-space:pre-wrap;">${escapeHtml(customMessage)}</div>` : ''}
    <a href="${link}" style="display:inline-block;padding:14px 28px;border-radius:999px;background:#1769ff;color:#ffffff;text-decoration:none;font-weight:700;">Complete Questionnaire</a>
    <p style="margin:24px 0 0;color:#5e6d82;font-size:13px;">You can save your progress and return to this same link at any time.</p>
  `;

  const subject = type === 'reminder'
    ? `Reminder: Complete "${questionnaire.title}" — Perler Technologies`
    : `${type === 'resend' ? 'Your questionnaire' : 'New questionnaire'}: ${questionnaire.title} — Perler Technologies`;

  const result = await sendResendEmail({ to: recipientEmail, subject, html: brandedEmailShell(bodyHtml) });

  await logQuestionnaireEmail(db, {
    questionnaireId: questionnaire._id,
    type,
    recipientEmail,
    customMessage,
    success: result.success,
    error: result.error
  });

  return result;
}

// Notifies the Perler Technologies admin (not the client) that a response was
// submitted. Sent to ADMIN_NOTIFICATION_EMAIL, same address api/inquiry.js already
// notifies for new inquiries.
async function sendCompletionNotificationEmail(db, { questionnaire, clientName, projectName, req }) {
  const adminLink = `${resolveSiteBase(req)}/admin#/questionnaires/${String(questionnaire._id)}`;

  const bodyHtml = `
    <p style="margin:0 0 18px;">A questionnaire has been completed.</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 24px;">
      <tr><td style="padding:8px 0;font-weight:700;width:140px;">Questionnaire</td><td style="padding:8px 0;">${escapeHtml(questionnaire.title)}</td></tr>
      <tr><td style="padding:8px 0;font-weight:700;">Client</td><td style="padding:8px 0;">${escapeHtml(clientName || 'Not specified')}</td></tr>
      <tr><td style="padding:8px 0;font-weight:700;">Project</td><td style="padding:8px 0;">${escapeHtml(projectName || 'Not specified')}</td></tr>
    </table>
    <a href="${adminLink}" style="display:inline-block;padding:14px 28px;border-radius:999px;background:#1769ff;color:#ffffff;text-decoration:none;font-weight:700;">Review Response</a>
  `;

  const result = await sendResendEmail({
    to: ADMIN_NOTIFICATION_EMAIL,
    subject: `Questionnaire completed: ${questionnaire.title}`,
    html: brandedEmailShell(bodyHtml)
  });

  await logQuestionnaireEmail(db, {
    questionnaireId: questionnaire._id,
    type: 'completion_notification',
    recipientEmail: ADMIN_NOTIFICATION_EMAIL,
    customMessage: null,
    success: result.success,
    error: result.error
  });

  return result;
}

module.exports = {
  ADMIN_NOTIFICATION_EMAIL,
  escapeHtml,
  sendResendEmail,
  sendQuestionnaireInviteEmail,
  sendCompletionNotificationEmail
};
