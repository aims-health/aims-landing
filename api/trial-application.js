// POST /api/trial-application
// Zero-dependency Vercel serverless function. Emails founding-cohort trial
// applications to tim@aimshealth.com.au via the Resend REST API.
//
// Requires env var RESEND_API_KEY (set in Vercel project settings).
// Optional: TRIAL_TO (override recipient), TRIAL_FROM (verified sender).
// Until RESEND_API_KEY is set the function returns 503 and the front-end
// falls back to a prefilled mailto: link, so the form is never dead.

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Body may arrive parsed (Vercel) or as a raw string.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  }
  body = body || {};

  const name = (body.name || '').toString().trim();
  const email = (body.email || '').toString().trim();
  const role = (body.role || '').toString().trim();
  const organisation = (body.organisation || '').toString().trim();
  const phone = (body.phone || '').toString().trim();
  const message = (body.message || '').toString().trim();

  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Name and a valid email are required.' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Not wired yet — tell the client so it can use the mailto fallback.
    return res.status(503).json({ error: 'Email backend not configured', fallback: true });
  }

  const to = process.env.TRIAL_TO || 'tim@aimshealth.com.au';
  const from = process.env.TRIAL_FROM || 'AiMS Health <applications@aimshealth.com.au>';

  const html =
    '<h2>New founding-cohort trial application</h2>' +
    '<table cellpadding="6" style="font-family:system-ui,sans-serif;font-size:14px;border-collapse:collapse">' +
    '<tr><td><strong>Name</strong></td><td>' + escapeHtml(name) + '</td></tr>' +
    '<tr><td><strong>Role</strong></td><td>' + escapeHtml(role) + '</td></tr>' +
    '<tr><td><strong>Organisation</strong></td><td>' + escapeHtml(organisation || '—') + '</td></tr>' +
    '<tr><td><strong>Email</strong></td><td>' + escapeHtml(email) + '</td></tr>' +
    '<tr><td><strong>Phone</strong></td><td>' + escapeHtml(phone || '—') + '</td></tr>' +
    '</table>' +
    '<p><strong>Using now / frustrations:</strong></p>' +
    '<p style="white-space:pre-wrap;font-family:system-ui,sans-serif;font-size:14px">' + escapeHtml(message || '—') + '</p>';

  const text =
    'New founding-cohort trial application\n\n' +
    'Name: ' + name + '\nRole: ' + role + '\nOrganisation: ' + (organisation || '-') +
    '\nEmail: ' + email + '\nPhone: ' + (phone || '-') + '\n\n' + (message || '-');

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: from,
        to: [to],
        reply_to: email,
        subject: 'Trial application — ' + name + (organisation ? ' (' + organisation + ')' : ''),
        html: html,
        text: text,
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(function () { return ''; });
      console.error('Resend error', r.status, detail);
      return res.status(502).json({ error: 'Email provider rejected the request.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('trial-application failed', err);
    return res.status(500).json({ error: 'Unexpected error sending email.' });
  }
};
