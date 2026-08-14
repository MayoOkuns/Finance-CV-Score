// Checks whether an email has an existing CV Pro purchase, so a returning
// customer's future scans auto-unlock Pro instead of asking them to pay
// again. CV Pro is deliberately accountless, so this email-based check is
// the only way to recognise a returning paying customer.
//
// Returns only a boolean — never exposes purchase details, amounts, or
// other emails. Safe to call from the client without authentication.

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({ error: 'Server not configured' });
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const email = (body?.email || '').trim().toLowerCase();
    if (!email) return res.status(200).json({ purchased: false });

    const res2 = await fetch(
      `${supabaseUrl}/rest/v1/cv_pro_purchases?email=eq.${encodeURIComponent(email)}&select=id&limit=1`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
    );
    if (!res2.ok) {
      console.error('check-cvpro query failed:', await res2.text());
      return res.status(200).json({ purchased: false }); // fail safe, not fail open
    }
    const rows = await res2.json();
    return res.status(200).json({ purchased: Array.isArray(rows) && rows.length > 0 });
  } catch (err) {
    console.error('check-cvpro error:', err.message);
    return res.status(200).json({ purchased: false });
  }
}
