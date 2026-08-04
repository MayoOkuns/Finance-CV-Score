import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Stripe webhook handler
// Listens for subscription events and updates Supabase profiles accordingly

// Vercel parses JSON bodies by default, which breaks Stripe signature
// verification (Stripe signs the raw bytes). Disable the parser and read
// the raw body ourselves.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!stripeSecret || !supabaseUrl || !supabaseServiceKey) {
    console.error('Missing environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Read raw bytes (bodyParser is disabled above)
  const rawBody = await readRawBody(req);
  const stripeSignature = req.headers['stripe-signature'];

  let event;

  // SECURITY: a webhook secret is MANDATORY. Without a verified signature,
  // anyone could POST a fake subscription event and grant themselves access.
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not set — refusing to process webhook.');
    return res.status(500).json({ error: 'Webhook not configured' });
  }
  if (!stripeSignature) {
    return res.status(400).json({ error: 'Missing signature' });
  }

  try {
    const crypto = await import('crypto');
    const parts = Object.fromEntries(
      stripeSignature.split(',').map(kv => kv.split('=').map(s => s.trim()))
    );
    const timestamp = parts['t'];
    const receivedSig = parts['v1'];
    if (!timestamp || !receivedSig) {
      return res.status(400).json({ error: 'Malformed signature' });
    }

    // Reject events older than 5 minutes (replay protection)
    const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
    if (isNaN(age) || age > 300 || age < -300) {
      return res.status(400).json({ error: 'Timestamp outside tolerance' });
    }

    const expectedSig = crypto.default
      .createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    // Timing-safe comparison
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

  // Supabase admin client (service role — bypasses RLS)
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  console.log('Webhook event type:', event.type);

  try {
    switch (event.type) {

      // New subscription created or trial started
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const status = subscription.status; // active, trialing, past_due, canceled

        // Map Stripe status to our status
        const profileStatus = status === 'active' ? 'active'
          : status === 'trialing' ? 'trial'
          : status === 'past_due' ? 'active' // grace period
          : 'free';

        // Get customer email from Stripe
        const stripeRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
          headers: { 'Authorization': `Bearer ${stripeSecret}` }
        });
        const customer = await stripeRes.json();
        const email = customer.email;

        if (!email) {
          console.error('No email found for customer:', customerId);
          break;
        }

        // Find user by email in Supabase auth
        const { data: users } = await supabase.auth.admin.listUsers();
        const user = users?.users?.find(u => u.email === email);

        if (!user) {
          console.log('User not found for email:', email, '— they may not have an account yet');
          break;
        }

        // Update profile
        const { error } = await supabase.from('profiles').upsert({
          id: user.id,
          email: email,
          subscription_status: profileStatus,
          subscription_id: subscription.id,
          trial_expires_at: subscription.trial_end
            ? new Date(subscription.trial_end * 1000).toISOString()
            : null
        });

        if (error) console.error('Profile update error:', error);
        else console.log(`Updated ${email} to status: ${profileStatus}`);

        // Sync to Brevo — add/update contact and list membership.
        // A Brevo automation on the Subscribers list sends the welcome email.
        try {
          const brevoKey = process.env.BREVO_API_KEY;
          const trialExpiresAt = subscription.trial_end
            ? new Date(subscription.trial_end * 1000).toISOString().split('T')[0]
            : null;

          // Correct default list IDs: Trial Users = 11, Active Subscribers = 10
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
                attributes: {
                  TRIAL_EXPIRES_AT: trialExpiresAt,
                  SUBSCRIPTION_STATUS: profileStatus
                },
                listIds: [brevoListId],
                updateEnabled: true
              })
            });
            if (!brevoRes.ok) {
              const errText = await brevoRes.text();
              console.error(`Brevo add failed (${brevoRes.status}) for ${email}:`, errText);
            } else {
              console.log(`Brevo contact synced for ${email} → list ${brevoListId}, status: ${profileStatus}`);
            }
          }
        } catch(brevoErr) {
          console.error('Brevo sync error:', brevoErr.message);
        }

        break;
      }

      // Subscription cancelled
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const stripeRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
          headers: { 'Authorization': `Bearer ${stripeSecret}` }
        });
        const customer = await stripeRes.json();
        const email = customer.email;

        if (email) {
          const { data: users } = await supabase.auth.admin.listUsers();
          const user = users?.users?.find(u => u.email === email);
          if (user) {
            await supabase.from('profiles').update({
              subscription_status: 'free',
              subscription_id: null
            }).eq('id', user.id);
            console.log(`Cancelled subscription for ${email}`);
          }
        }
        break;
      }

      // Payment failed — could downgrade access
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.log('Payment failed for customer:', invoice.customer);
        // For now just log — could add email notification later
        break;
      }

      default:
        console.log('Unhandled event type:', event.type);
    }

    return res.status(200).json({ received: true });

  } catch(err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}
