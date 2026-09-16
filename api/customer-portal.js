// Rate limiter — 20 requests per IP per 10 minutes
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + 600000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 600000; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count > 20;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return res.status(500).json({ error: 'Stripe not configured' });

  try {
    // Find ALL Stripe customers with this email — not just the first one.
    // Duplicate customer records for the same email are a known real risk
    // (e.g. someone checking out more than once), and the old code here
    // only ever looked at the first match, silently leaving any other
    // customer's subscription unmanaged and still charging.
    const searchRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=10`,
      { headers: { 'Authorization': `Bearer ${stripeSecret}` } }
    );
    const searchData = await searchRes.json();
    const customers = searchData.data || [];

    if (customers.length === 0) {
      return res.status(404).json({ error: 'No Stripe customer found for this email' });
    }

    // For each customer record, check whether they actually have an active
    // subscription — rather than trusting arbitrary list order.
    const activeCustomers = [];
    for (const c of customers) {
      const subRes = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${c.id}&status=active&limit=1`,
        { headers: { 'Authorization': `Bearer ${stripeSecret}` } }
      );
      const subData = await subRes.json();
      if (subData.data && subData.data.length > 0) activeCustomers.push(c);
    }

    let customer;
    if (activeCustomers.length === 1) {
      // Normal case, now correctly robust even if duplicate customer
      // records exist: exactly one has a genuinely active subscription.
      customer = activeCustomers[0];
    } else if (activeCustomers.length > 1) {
      // Genuine duplicate-subscription case (what likely caused this bug).
      // The self-serve portal can only manage one customer per session, so
      // silently picking one here would just repeat the original problem.
      // Surface it clearly instead, with enough detail to resolve manually.
      console.error(`DUPLICATE ACTIVE SUBSCRIPTIONS for ${email}: customer ids`, activeCustomers.map(c => c.id).join(', '));
      return res.status(409).json({
        error: 'duplicate_subscriptions',
        message: 'You have more than one active subscription on this email. Please contact hello@financecareervault.com so we can resolve this and refund any duplicate charges — please don\'t subscribe again in the meantime.'
      });
    } else {
      // No active subscription found on any matching customer record —
      // fall back to the most recently created customer for the portal,
      // so cancelled/expired history is still viewable.
      customer = customers[0];
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
        return_url: 'https://www.financecareervault.com/vault.html'
      })
    });

    const portalData = await portalRes.json();

    if (portalData.error) {
      console.error('Stripe portal error:', portalData.error);
      console.error('Portal error:', portalData.error.message);
      return res.status(500).json({ error: 'Could not open billing portal. Please try again.' });
    }

    return res.status(200).json({ url: portalData.url });

  } catch (err) {
    console.error('Portal error:', err);
    return res.status(500).json({ error: 'Failed to create portal session' });
  }
}
