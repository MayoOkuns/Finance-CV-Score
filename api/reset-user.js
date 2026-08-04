// Admin-only: reset or fully delete a user by email, so a real email can be
// re-used to test the full sign-up / subscribe / cancel flow end-to-end.
//
// Uses direct Supabase REST calls (not the SDK admin helpers) for reliability
// in the serverless runtime, and always returns JSON — even on error — so the
// client never tries to parse an HTML error page.
//
// mode = 'reset'  → clears subscription + preview access, keeps the account
// mode = 'delete' → removes preview access, profile row, AND the auth user

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    const adminEmail = process.env.ADMIN_EMAIL || 'mayo.okuns@gmail.com';
    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({ error: 'Server not configured (missing Supabase service key)' });
    }

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized — no token' });

    const whoRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${token}` }
    });
    if (!whoRes.ok) return res.status(401).json({ error: 'Unauthorized — invalid token' });
    const who = await whoRes.json();
    if (!who?.email || who.email.toLowerCase() !== adminEmail.toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden — admin only' });
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const email = body?.email;
    const mode = body?.mode || 'reset';
    if (!email) return res.status(400).json({ error: 'Email required' });

    // Safety: never delete the admin's own account (would lock you out of admin).
    if (mode === 'delete' && email.toLowerCase() === adminEmail.toLowerCase()) {
      return res.status(400).json({ error: 'Cannot delete the admin account. Use Reset instead to clear its subscription.' });
    }

    const H = {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json'
    };

    const listRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=200`, { headers: H });
    if (!listRes.ok) {
      const t = await listRes.text();
      console.error('List users failed:', t);
      return res.status(500).json({ error: 'Could not list users' });
    }
    const listJson = await listRes.json();
    const users = listJson?.users || listJson || [];
    const user = users.find(u => (u.email || '').toLowerCase() === String(email).toLowerCase());
    if (!user) return res.status(404).json({ error: 'No user found with that email' });

    await fetch(`${supabaseUrl}/rest/v1/preview_access?user_id=eq.${user.id}`, {
      method: 'DELETE', headers: H
    });

    if (mode === 'delete') {
      await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}`, { method: 'DELETE', headers: H });
      const delRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
        method: 'DELETE', headers: H
      });
      if (!delRes.ok) {
        const t = await delRes.text();
        console.error('Delete user failed:', t);
        return res.status(500).json({ error: 'Could not delete the auth user' });
      }
      return res.status(200).json({ ok: true, action: 'deleted', email });
    } else {
      await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}`, {
        method: 'PATCH', headers: H,
        body: JSON.stringify({
          subscription_status: 'free',
          subscription_id: null,
          trial_expires_at: null,
          cv_pro_purchased: false
        })
      });
      return res.status(200).json({ ok: true, action: 'reset', email });
    }
  } catch (err) {
    console.error('reset-user fatal:', err && err.message);
    return res.status(500).json({ error: 'Server error: ' + (err && err.message ? err.message : 'unknown') });
  }
}
