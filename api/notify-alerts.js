export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { firm, questionText, questionId } = req.body;

  if (!firm) return res.status(400).json({ error: 'Firm is required' });

  const brevoKey = process.env.BREVO_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!brevoKey || !supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // Find all users who have an alert set for this firm
    const alertsRes = await fetch(
      `${supabaseUrl}/rest/v1/interview_alerts?firm=eq.${encodeURIComponent(firm)}&select=user_id`,
      {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        }
      }
    );
    const alerts = await alertsRes.json();

    if (!alerts || alerts.length === 0) {
      return res.status(200).json({ sent: 0, message: 'No subscribers for this firm' });
    }

    // Get user emails from Supabase auth
    const userIds = alerts.map(a => a.user_id);

    const usersRes = await fetch(
      `${supabaseUrl}/auth/v1/admin/users`,
      {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        }
      }
    );
    const usersData = await usersRes.json();
    const users = usersData.users || [];

    // Filter to only users with alerts for this firm
    const recipients = users
      .filter(u => userIds.includes(u.id) && u.email)
      .map(u => ({ email: u.email }));

    if (recipients.length === 0) {
      return res.status(200).json({ sent: 0, message: 'No valid email addresses found' });
    }

    // Send email via Brevo
    const emailBody = {
      sender: { name: 'Finance Career Vault', email: 'hello@financecareervault.com' },
      to: recipients,
      subject: `🔔 New ${firm} interview question added`,
      htmlContent: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">
          <div style="background:#0F172A;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
            <h1 style="font-family:Georgia,serif;color:white;font-size:22px;margin:0 0 6px">
              Finance<span style="color:#93C5FD">CareerVault</span>
            </h1>
            <p style="color:rgba(255,255,255,.6);font-size:13px;margin:0">Interview Vault Alert</p>
          </div>

          <h2 style="font-size:20px;color:#0E0E0F;margin:0 0 8px">
            New question added for <strong>${firm}</strong>
          </h2>
          <p style="font-size:14px;color:#3A3A3C;line-height:1.6;margin:0 0 20px">
            A candidate has just submitted a new interview question for ${firm}.
            Log in to see the full question and browse all recent submissions.
          </p>

          ${questionText ? `
          <div style="background:#F7F6F3;border-left:3px solid #2563EB;border-radius:0 8px 8px 0;padding:16px;margin-bottom:24px">
            <p style="font-size:13px;color:#7A7A80;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.06em;font-weight:600">Question preview</p>
            <p style="font-size:15px;color:#0E0E0F;margin:0;line-height:1.5">${questionText.substring(0, 120)}${questionText.length > 120 ? '…' : ''}</p>
          </div>
          ` : ''}

          <a href="https://www.financecareervault.com/vault.html?firm=${encodeURIComponent(firm)}"
            style="display:block;background:#2563EB;color:white;text-align:center;padding:14px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;margin-bottom:20px">
            View question in the vault →
          </a>

          <p style="font-size:12px;color:#7A7A80;text-align:center;line-height:1.6">
            You're receiving this because you set up a firm alert for ${firm} on Finance Career Vault.<br>
            <a href="https://www.financecareervault.com/vault.html" style="color:#2563EB">Manage your alerts</a>
          </p>
        </div>
      `
    };

    const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': brevoKey
      },
      body: JSON.stringify(emailBody)
    });

    const emailData = await emailRes.json();
    console.log('Brevo response:', emailData);

    return res.status(200).json({
      success: true,
      sent: recipients.length,
      firm
    });

  } catch(err) {
    console.error('Notify alerts error:', err);
    return res.status(500).json({ error: 'Failed to send alerts', details: err.message });
  }
}
