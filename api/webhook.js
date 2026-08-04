// Stripe webhook handler — updates Supabase profiles + syncs to Brevo.
// Uses direct REST calls (no SDK import) so it runs reliably in Vercel's
// serverless runtime. Verifies Stripe signatures on the raw body.

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Find a Supabase auth user by email via the admin REST endpoint
async function findUserByEmail(supabaseUrl, serviceKey, email) {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=200`, {
    headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
  });
  if (!res.ok) { console.error('listUsers failed:', await res.text()); return null; }
  const json = await res.json();
  const users = json?.users || json || [];
  return users.find(u => (u.email || '').toLowerCase() === String(email).toLowerCase()) || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!stripeSecret || !supabaseUrl || !serviceKey) {
    console.error('Missing environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const rawBody = await readRawBody(req);
  const stripeSignature = req.headers['stripe-signature'];

  let event;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not set — refusing to process webhook.');
    return res.status(500).json({ error: 'Webhook not configured' });
  }
  if (!stripeSignature) return res.status(400).json({ error: 'Missing signature' });

  try {
    const crypto = await import('crypto');
    const parts = Object.fromEntries(
      stripeSignature.split(',').map(kv => kv.split('=').map(s => s.trim()))
    );
    const timestamp = parts['t'];
    const receivedSig = parts['v1'];
    if (!timestamp || !receivedSig) return res.status(400).json({ error: 'Malformed signature' });

    const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
    if (isNaN(age) || age > 300 || age < -300) {
      return res.status(400).json({ error: 'Timestamp outside tolerance' });
    }

    const expectedSig = crypto.default
      .createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    const a = Buffer.from(expectedSig, 'hex');
    const b = Buffer.from(receivedSig, 'hex');
    if (a.length !== b.length || !crypto.default.timingSafeEqual(a, b)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    event = JSON.parse(rawBody);
  } catch(err) {
    console.error('Signature verification error:', err.message);
    return res.status(400).json({ error: 'Signature verification failed' });
  }

  const SB = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };

  console.log('Webhook event type:', event.type);

  try {
    switch (event.type) {

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const status = subscription.status;

        const profileStatus = status === 'active' ? 'active'
          : status === 'trialing' ? 'trial'
          : status === 'past_due' ? 'active'
          : 'free';

        const stripeRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
          headers: { 'Authorization': `Bearer ${stripeSecret}` }
        });
        const customer = await stripeRes.json();
        const email = customer.email;
        if (!email) { console.error('No email for customer:', customerId); break; }

        const user = await findUserByEmail(supabaseUrl, serviceKey, email);
        if (!user) { console.log('User not found for email:', email); break; }

        // Upsert profile via REST
        const upRes = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
          method: 'POST',
          headers: { ...SB, 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({
            id: user.id,
            email: email,
            subscription_status: profileStatus,
            subscription_id: subscription.id,
            trial_expires_at: subscription.trial_end
              ? new Date(subscription.trial_end * 1000).toISOString() : null
          })
        });
        if (!upRes.ok) console.error('Profile upsert failed:', await upRes.text());
        else console.log(`Updated ${email} to status: ${profileStatus}`);

        // Sync to Brevo (a Brevo automation on the Subscribers list sends the welcome email)
        try {
          const brevoKey = process.env.BREVO_API_KEY;
          const trialExpiresAt = subscription.trial_end
            ? new Date(subscription.trial_end * 1000).toISOString().split('T')[0] : null;
          const brevoListId = profileStatus === 'trial'
            ? parseInt(process.env.BREVO_TRIAL_LIST_ID || '11')
            : parseInt(process.env.BREVO_SUBSCRIBERS_LIST_ID || '10');

          if (!brevoKey) {
            console.error('BREVO_API_KEY not set — cannot add contact to Brevo');
          } else {
            const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'api-key': brevoKey },
              body: JSON.stringify({
                email,
                attributes: { TRIAL_EXPIRES_AT: trialExpiresAt, SUBSCRIPTION_STATUS: profileStatus },
                listIds: [brevoListId],
                updateEnabled: true
              })
            });
            if (!brevoRes.ok) console.error(`Brevo add failed (${brevoRes.status}) for ${email}:`, await brevoRes.text());
            else console.log(`Brevo contact synced for ${email} -> list ${brevoListId}`);
          }
        } catch(brevoErr) {
          console.error('Brevo sync error:', brevoErr.message);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const stripeRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
          headers: { 'Authorization': `Bearer ${stripeSecret}` }
        });
        const customer = await stripeRes.json();
        const email = customer.email;
        if (email) {
          const user = await findUserByEmail(supabaseUrl, serviceKey, email);
          if (user) {
            await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}`, {
              method: 'PATCH', headers: SB,
              body: JSON.stringify({ subscription_status: 'free', subscription_id: null })
            });
            console.log(`Cancelled subscription for ${email}`);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.log('Payment failed for customer:', invoice.customer);
        break;
      }

      default:
        console.log('Unhandled event type:', event.type);
    }

    return res.status(200).json({ received: true });
  } catch(err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}
