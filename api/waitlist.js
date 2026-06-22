export default async function handler(req, res) {
  // CORS — allow both www and non-www
  const origin = req.headers.origin || '';
  const allowed = [
    'https://financecvscore.com',
    'https://www.financecvscore.com',
    'https://finance-cv-score-index-git-main-mayowa-project.vercel.app'
  ];
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
  // Handle preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { email } = req.body;
 
  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
 
  const apiKey = process.env.BREVO_API_KEY;
  const listId = parseInt(process.env.BREVO_LIST_ID || '0');
 
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
 
    if (response.status === 201 || response.status === 204) {
      return res.status(200).json({ success: true });
    }
 
    const data = await response.json();
 
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
