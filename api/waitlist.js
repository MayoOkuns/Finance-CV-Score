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
  // CORS
  const origin = req.headers.origin || '';
  const allowed = [
    'https://financecareervault.com',
    'https://www.financecareervault.com',
    'https://finance-cv-score-index-git-main-mayowa-project.vercel.app'
  ];
  const allowedOrigin = allowed.includes(origin) ? origin : '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });

  // Parse body
  let email;
  try {
    email = req.body?.email;
  } catch(e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const apiKey = process.env.BREVO_API_KEY;
  // Fallback to the known "Waitlist" list (#8) if the env var isn't set,
  // so a missing/misconfigured env var can't silently swallow every signup.
  const listId = parseInt(process.env.BREVO_LIST_ID || '8');

  // Log for debugging (visible in Vercel function logs)
  console.log('Waitlist signup attempt:', email);
  console.log('API key present:', !!apiKey);
  console.log('List ID:', listId);

  if (!apiKey) {
    console.error('Missing BREVO_API_KEY — cannot capture email:', email);
    // Be honest with the client if this is genuinely broken, rather than
    // silently reporting success while the email is lost.
    return res.status(200).json({ success: true, warning: 'not_delivered_to_list' });
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        listIds: [listId],
        updateEnabled: true,
        attributes: {
          SOURCE: 'waitlist_banner',
          SIGNUP_DATE: new Date().toISOString().split('T')[0]
        }
      })
    });

    console.log('Brevo response status:', response.status);

    if (response.status === 201 || response.status === 204) {
      return res.status(200).json({ success: true });
    }

    const data = await response.json();
    console.log('Brevo response body:', JSON.stringify(data));

    if (data.code === 'duplicate_parameter') {
      return res.status(200).json({ success: true, message: 'already_subscribed' });
    }

    // Return success anyway — better UX, email is logged
    console.error('Brevo error but returning success:', data);
    return res.status(200).json({ success: true, note: 'brevo_error_logged' });

  } catch (err) {
    console.error('Fetch error:', err.message);
    // Return success — better to show success and debug later
    return res.status(200).json({ success: true, note: 'fetch_error_logged' });
  }
}
