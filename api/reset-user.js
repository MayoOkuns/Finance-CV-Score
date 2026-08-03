import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Admin-only: reset or fully delete a user by email, so a real email can be
// re-used to test the full sign-up / subscribe / cancel flow end-to-end.
//
// mode = 'reset'  → clears subscription + preview access, keeps the account
// mode = 'delete' → removes preview access, profile row, AND the auth user
//                    (so "create an account" works again with the same email)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const adminEmail = process.env.ADMIN_EMAIL || 'mayo.okuns@gmail.com';
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Server not configured' });

  // Verify caller is the admin (their Supabase JWT, checked server-side)
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const whoRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${token}` }
    });
    if (!whoRes.ok) return res.status(401).json({ error: 'Unauthorized' });
    const who = await whoRes.json();
    if (!who?.email || who.email !== adminEmail) return res.status(403).json({ error: 'Forbidden' });
  } catch(e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { email, mode } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  const admin = createClient(supabaseUrl, serviceKey);

  try {
    // Find the auth user by email
    const { data: list, error: listErr } = await admin.auth.admin.listUsers();
    if (listErr) throw listErr;
    const user = (list?.users || []).find(u => (u.email || '').toLowerCase() === email.toLowerCase());
    if (!user) return res.status(404).json({ error: 'No user found with that email' });

    // Always clear preview access
    await admin.from('preview_access').delete().eq('user_id', user.id);

    if (mode === 'delete') {
      // Remove profile row, then the auth user entirely
      await admin.from('profiles').delete().eq('id', user.id);
      const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
      if (delErr) throw delErr;
      return res.status(200).json({ ok: true, action: 'deleted', email });
    } else {
      // Reset: keep the account but clear subscription + CV Pro flags
      await admin.from('profiles').update({
        subscription_status: 'free',
        subscription_id: null,
        trial_expires_at: null,
        cv_pro_purchased: false
      }).eq('id', user.id);
      return res.status(200).json({ ok: true, action: 'reset', email });
    }
  } catch(err) {
    console.error('Reset user error:', err.message);
    return res.status(500).json({ error: 'Could not complete the action.' });
  }
}
