export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '';
  const allowed = ['https://financecvscore.com','https://www.financecvscore.com'];
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cvText, industry, jobRole, jdText, missingKeywords } = req.body;

  if (!cvText || cvText.length < 50) {
    return res.status(400).json({ error: 'CV text is required' });
  }

  // Verify payment — check Supabase for CV Pro purchase
  // (For now we trust the client — full verification added in next iteration)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API not configured' });

  const industryLabels = {
    ib:'Investment Banking', am:'Asset Management', pe:'Private Equity',
    hf:'Hedge Funds', er:'Equity Research', st:'Sales & Trading',
    wm:'Wealth Management', cf:'Corporate Finance / FP&A',
    insurance:'Insurance / Actuarial', risk:'Risk & Compliance',
    retailbank:'Retail / Commercial Banking', fintech:'Fintech'
  };

  const indLabel = industryLabels[industry] || 'Finance';
  const roleLabel = jobRole || indLabel;
  const kwList = missingKeywords && missingKeywords.length > 0
    ? `\nMissing keywords to inject naturally: ${missingKeywords.slice(0,8).join(', ')}`
    : '';
  const jdSection = jdText && jdText.length > 50
    ? `\n\nJOB DESCRIPTION (tailor every line to this):\n${jdText.substring(0,1500)}`
    : '';

  const prompt = `You are an elite finance CV writer who has helped hundreds of candidates land roles at Goldman Sachs, BlackRock, JPMorgan, KKR, and similar firms. You know exactly what ${indLabel} recruiters want to see.

Rewrite the following CV for a ${roleLabel} role. Follow these rules precisely:

STRUCTURE (exact order, no exceptions):
1. Candidate name — prominent, centred
2. Contact line — phone | email | LinkedIn (one line)
3. EDUCATION — for finance CVs, education comes BEFORE experience for graduates; include all institutions, grades, relevant modules
4. RELEVANT EXPERIENCE — each role: Company | Title | Location | Dates, then 3-6 bullet points
5. ACADEMIC ACHIEVEMENTS AND LEADERSHIP — if present in original
6. EXTRA CURRICULAR ACTIVITIES AND SKILLS — tools, certifications, interests

RULES:
- Keep every real fact — do NOT invent companies, dates, qualifications, or figures
- Every bullet point starts with a strong action verb (Led, Delivered, Drove, Developed etc.)
- Quantify every achievement where a number exists in the original — never invent numbers
- ${industry === 'ib' ? 'CRITICAL: Output must fit on exactly 1 page — be ruthless with conciseness. Remove anything not directly relevant to IB.' : 'Keep to 1-2 pages maximum.'}
- ${jdText && jdText.length > 50 ? 'CRITICAL: Match the exact language and keywords from the job description throughout.' : ''}
${kwList}
- Output PLAIN TEXT only — no markdown, no asterisks, no # symbols, no bold markers
- Section headings in ALL CAPS
- Bullet points use •
- This is a COMPLETE, SUBMISSION-READY CV — not a framework${jdSection}

ORIGINAL CV:
${cvText.substring(0,3000)}

Output the complete rewritten CV now, starting directly with the candidate name:`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('Anthropic error:', data.error);
      return res.status(500).json({ error: 'Rewrite failed', details: data.error.message });
    }

    const rewriteText = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    if (!rewriteText || rewriteText.length < 100) {
      return res.status(500).json({ error: 'Empty rewrite response' });
    }

    return res.status(200).json({ success: true, rewriteText });

  } catch (err) {
    console.error('Rewrite error:', err);
    return res.status(500).json({ error: 'Rewrite failed', details: err.message });
  }
}
