const RECIPIENT_EMAIL = 'kirby@perlertechnologies.com';
const ALLOWED_PROJECT_TYPES = new Set([
  'Business website',
  'Custom web application',
  'Dashboard or portal',
  'Automation or integration',
  'Existing website or system update',
  'Other'
]);

function clean(value, maxLength = 1000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function escapeHtml(value) {
  return clean(value, 5000)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const name = clean(body.name, 120);
  const company = clean(body.company, 160);
  const email = clean(body.email, 180);
  const phone = clean(body.phone, 40);
  const projectType = clean(body.projectType, 120);
  const projectDetails = clean(body.projectDetails, 5000);
  const timeline = clean(body.timeline, 160);
  const referenceLinks = clean(body.referenceLinks, 1000);

  if (!name || !email || !phone || !projectType || !projectDetails) {
    return res.status(400).json({ error: 'Please complete all required fields.' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  if (!ALLOWED_PROJECT_TYPES.has(projectType)) {
    return res.status(400).json({ error: 'Please select a valid project type.' });
  }

  if (!process.env.RESEND_API_KEY) {
    console.error('Missing RESEND_API_KEY environment variable.');
    return res.status(500).json({ error: 'Email delivery has not been configured yet.' });
  }

  const fromEmail = process.env.INQUIRY_FROM_EMAIL || 'Perler Technologies <onboarding@resend.dev>';
  const subject = `New project inquiry — ${projectType} — ${name}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#0c1d37;line-height:1.6">
      <h1 style="font-size:24px;margin-bottom:24px">New Perler Technologies inquiry</h1>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:10px 0;font-weight:bold;width:160px">Name</td><td style="padding:10px 0">${escapeHtml(name)}</td></tr>
        <tr><td style="padding:10px 0;font-weight:bold">Company</td><td style="padding:10px 0">${escapeHtml(company || 'Not provided')}</td></tr>
        <tr><td style="padding:10px 0;font-weight:bold">Email</td><td style="padding:10px 0">${escapeHtml(email)}</td></tr>
        <tr><td style="padding:10px 0;font-weight:bold">Phone</td><td style="padding:10px 0">${escapeHtml(phone)}</td></tr>
        <tr><td style="padding:10px 0;font-weight:bold">Project type</td><td style="padding:10px 0">${escapeHtml(projectType)}</td></tr>
        <tr><td style="padding:10px 0;font-weight:bold">Timeline</td><td style="padding:10px 0">${escapeHtml(timeline || 'Not provided')}</td></tr>
        <tr><td style="padding:10px 0;font-weight:bold">Reference links</td><td style="padding:10px 0">${escapeHtml(referenceLinks || 'Not provided')}</td></tr>
      </table>
      <h2 style="font-size:18px;margin:28px 0 10px">Project details</h2>
      <div style="white-space:pre-wrap;padding:18px;border-radius:10px;background:#f5f8fc">${escapeHtml(projectDetails)}</div>
    </div>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [RECIPIENT_EMAIL],
        reply_to: email,
        subject,
        html
      })
    });

    if (!response.ok) {
      const details = await response.text();
      console.error('Resend error:', response.status, details);
      return res.status(502).json({ error: 'The inquiry could not be delivered right now.' });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Inquiry email error:', error);
    return res.status(500).json({ error: 'The inquiry could not be delivered right now.' });
  }
};
