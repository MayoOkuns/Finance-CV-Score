export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '';
  const allowed = ['https://financecareervault.com','https://www.financecareervault.com'];
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cvText, industry, jobRole, jdText } = req.body;

  if (!cvText || cvText.length < 50) {
    return res.status(400).json({ error: 'CV text is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API not configured' });
  }

  const industryLabels = {
    ib:'Investment Banking', am:'Asset Management', pe:'Private Equity',
    hf:'Hedge Funds', er:'Equity Research', st:'Sales & Trading',
    wm:'Wealth Management', cf:'Corporate Finance / FP&A',
    insurance:'Insurance / Actuarial', risk:'Risk & Compliance',
    retailbank:'Retail / Commercial Banking', fintech:'Fintech'
  };

  const industryGuidance = {
    ib: 'IB CVs must be exactly 1 page. Recruiters expect deal/pitch experience, DCF/LBO modelling, and technical rigour. Quantify everything.',
    am: 'AM CVs should show investment process understanding, stock pitch experience, and tools (Bloomberg, FactSet). CFA progress is a strong signal.',
    pe: 'PE CVs need prior IB/consulting experience, LBO modelling, deal exposure, and specific workstream contributions. Quantify deal sizes and returns.',
    hf: 'HF CVs reward differentiated thinking, specific strategy exposure, quantitative skills, and evidence of independent investment analysis.',
    er: 'ER CVs need sector specialism, modelling skills, and evidence of written analysis. CFA is highly valued.',
    st: 'S&T CVs reward market awareness, quick decision-making evidence, and numerical agility. Trading simulations and PnL awareness stand out.',
    wm: 'WM CVs need relationship management evidence, client service orientation, and product knowledge.',
    cf: 'CF/FP&A CVs should show budgeting, forecasting, variance analysis, and business partnering with commercial storytelling.',
    insurance: 'Insurance CVs benefit from actuarial exam progress, pricing/reserving exposure, and regulatory knowledge (Solvency II).',
    risk: 'Risk CVs need regulatory framework knowledge (Basel, FCA, MiFID), risk methodologies (VaR, stress testing), and FRM/CFA certifications.',
    retailbank: 'Retail banking CVs should emphasise customer outcomes, product knowledge, and quantified sales/service targets.',
    fintech: 'Fintech CVs should blend financial domain knowledge with technical/product fluency and platform understanding.'
  };

  const indLabel = industryLabels[industry] || 'Finance';
  const indGuide = industryGuidance[industry] || '';
  const roleContext = jobRole ? `Target role: ${jobRole}.` : '';
  const jdContext = jdText && jdText.length > 50
    ? `\n\nJob Description provided:\n${jdText.substring(0, 1500)}`
    : '';

  const prompt = `You are an elite finance CV expert with 15 years of experience at top investment banks and asset managers. You have reviewed thousands of CVs for ${indLabel} roles.

Analyse this CV for a ${indLabel} role. ${roleContext}${jdContext}

CV TEXT:
${cvText.substring(0, 3000)}

Industry guidance for ${indLabel}: ${indGuide}

Return ONLY a valid JSON object (no markdown, no backticks):
{
  "overallScore": <0-100 integer>,
  "scoreTitle": <"Low Interview Probability"|"Low-Medium Probability"|"Good Interview Probability"|"High Interview Probability">,
  "scoreVerdict": <2 specific sentences about this CV's chances for ${indLabel} roles>,
  "pills": [<3-4 short label strings>],
  "pillColors": [<"red"|"amber"|"green" for each pill>],
  "breakdown": [
    {"label":"ATS Compatibility","score":<0-100>},
    {"label":"Keyword Density","score":<0-100>},
    {"label":"Formatting","score":<0-100>},
    {"label":"Impact & Results","score":<0-100>},
    {"label":"Readability","score":<0-100>}
  ],
  "issues": [
    {
      "severity": <"red"|"amber"|"green">,
      "icon": <single emoji>,
      "title": <specific issue title>,
      "description": <2 sentences: what is wrong AND how to fix it, specific to ${indLabel}>
    }
  ],
  "keywordsPresent": [<6-8 keywords found in the CV relevant to ${indLabel}>],
  "keywordsMissing": [<8-10 important keywords missing for ${indLabel} roles>],
  "jdMatchScore": ${jdText && jdText.length > 50 ? '<0-100 match score against the provided JD>' : 'null'},
  "jdMissingTerms": ${jdText && jdText.length > 50 ? '[<6-8 specific terms from JD missing in CV>]' : 'null'}
}

Rules:
- Be brutally specific — no generic advice, reference actual content from the CV
- Issues array: 4-6 items ordered red → amber → green
- Score scoring guide: 80+ = genuinely strong for this sub-sector, 65-79 = good with fixable gaps, 48-64 = fair/below average, below 48 = significant issues
- ${indLabel === 'Investment Banking' ? 'For IB: penalise heavily if CV is not 1 page, has no deal/pitch experience, or lacks technical modelling skills' : ''}
- Reference specific firms, tools, or qualifications mentioned in the CV`;

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
      return res.status(500).json({ error: 'AI analysis failed', details: data.error.message });
    }

    const raw = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Invalid AI response format' });
    }

    const result = JSON.parse(jsonMatch[0]);
    result.industry = industry;

    return res.status(200).json({ success: true, result });

  } catch (err) {
    console.error('Analysis error:', err);
    return res.status(500).json({ error: 'Analysis failed', details: err.message });
  }
}
