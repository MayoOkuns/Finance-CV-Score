export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS headers so the browser can call this from financecvscore.com
  res.setHeader('Access-Control-Allow-Origin', 'https://financecvscore.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const { email } = req.body;

  // Basic email validation
  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  // Read keys from Vercel environment variables (never exposed to browser)
  const apiKey  = process.env.BREVO_API_KEY;
  const listId  = parseInt(process.env.BREVO_LIST_ID || '0');

  if (!apiKey || !listId) {
    console.error('Missing Brevo environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
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

    // 204 = already exists (Brevo returns this when contact is updated)
    // 201 = created successfully
    if (response.status === 201 || response.status === 204) {
      return res.status(200).json({ success: true });
    }

    const data = await response.json();

    // Brevo error code 'duplicate_parameter' means email already on list — treat as success
    if (data.code === 'duplicate_parameter') {
      return res.status(200).json({ success: true, message: 'already_subscribed' });
    }

    console.error('Brevo API error:', data);
    return res.status(500).json({ error: 'Failed to add contact' });

  } catch (err) {
    console.error('Fetch error:', err);
    return res.status(500).json({ error: 'Network error' });
  }
}
