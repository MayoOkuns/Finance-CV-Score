export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return res.status(500).json({ error: 'Stripe not configured' });

  try {
    // Find Stripe customer by email
    const searchRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { 'Authorization': `Bearer ${stripeSecret}` } }
    );
    const searchData = await searchRes.json();
    const customer = searchData.data?.[0];

    if (!customer) {
      return res.status(404).json({ error: 'No Stripe customer found for this email' });
    }

    // Create a Customer Portal session
    const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecret}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        customer: customer.id,
        return_url: 'https://www.financecvscore.com/vault.html'
      })
    });

    const portalData = await portalRes.json();

    if (portalData.error) {
      console.error('Stripe portal error:', portalData.error);
      return res.status(500).json({ error: portalData.error.message });
    }

    return res.status(200).json({ url: portalData.url });

  } catch (err) {
    console.error('Portal error:', err);
    return res.status(500).json({ error: 'Failed to create portal session' });
  }
}
