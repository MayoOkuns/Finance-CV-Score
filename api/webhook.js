import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Stripe webhook handler
// Listens for subscription events and updates Supabase profiles accordingly

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

  // Get raw body for signature verification
  const rawBody = JSON.stringify(req.body);
  const stripeSignature = req.headers['stripe-signature'];

  let event;

  // Verify webhook signature if secret is set
  if (webhookSecret && stripeSignature) {
    try {
      // Simple HMAC verification without the full Stripe SDK
      const crypto = await import('crypto');
      const [timestampPart, ...sigParts] = stripeSignature.split(',');
      const timestamp = timestampPart.replace('t=', '');
      const expectedSig = crypto.default
        .createHmac('sha256', webhookSecret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');
      const receivedSig = sigParts.find(s => s.startsWith('v1='))?.replace('v1=', '');
      if (expectedSig !== receivedSig) {
        return res.status(400).json({ error: 'Invalid signature' });
      }
      event = req.body;
    } catch(err) {
      console.error('Signature verification error:', err);
      return res.status(400).json({ error: 'Signature verification failed' });
    }
  } else {
    // No webhook secret set — accept all events (development only)
    event = req.body;
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
          subscription_status: profileStatus,
          subscription_id: subscription.id,
          trial_expires_at: subscription.trial_end
            ? new Date(subscription.trial_end * 1000).toISOString()
            : null
        });

        if (error) console.error('Profile update error:', error);
        else console.log(`Updated ${email} to status: ${profileStatus}`);
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
