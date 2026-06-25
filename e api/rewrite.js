export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cvText, industry, jobRole, jdText, missingKeywords } = req.body;
  if (!cvText || cvText.length < 50) return res.status(400).json({ error: 'CV text required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API not configured' });

  // ── SUB-SECTOR HARD RULES ──────────────────────────────────────────
  const sectorRules = {
    ib: {
      label: 'Investment Banking',
      rules: [
        'CRITICAL: Output must fit on exactly 1 page. Be ruthlessly concise. Cut anything not directly relevant to IB.',
        'Structure order: Name + contact → Education → Relevant Experience → Academic Achievements → Skills. NO personal statement or profile section.',
        'Education section must come BEFORE experience for graduates and early-career candidates.',
        'Every bullet point must start with a PAST TENSE action verb (Led, Delivered, Executed, Structured, Analysed, Developed, Presented, Collaborated).',
        'Bullet points must follow the format: [Action verb] + [what you did] + [quantified result or scope where a number exists in the original].',
        'Include deal/transaction sizes in £/$m where mentioned in the original CV.',
        'Technical skills (DCF, LBO, M&A, comparable analysis, financial modelling) must be named explicitly where present.',
        'Tools must be listed explicitly: Bloomberg, FactSet, Morningstar, Aladdin, Excel, VBA, Python.',
        'Do NOT invent numbers, deals, or achievements. Only use what is in the original CV.',
      ],
      keywordContext: 'IB keywords to inject where contextually appropriate: pitchbook, M&A, DCF, LBO, comparable company analysis, precedent transactions, capital markets, due diligence, financial modelling, deal execution, valuation.'
    },
    am: {
      label: 'Asset Management',
      rules: [
        'Output should be 1 page for graduates, up to 1.5 pages for experienced candidates.',
        'Structure order: Name + contact → Education → Relevant Experience → Academic Achievements → Skills.',
        'Education before experience for graduates.',
        'A SHORT 2-line professional summary is acceptable for AM (unlike IB) — only if it adds specific value (e.g. "CFA Level 1 candidate with equity research and portfolio analysis experience across long/short and multi-asset strategies").',
        'Every bullet must start with a past tense action verb.',
        'Emphasise investment process: bottom-up/top-down analysis, stock pitches, portfolio construction, attribution analysis.',
        'Include AUM figures, fund names, and performance metrics where mentioned in the original.',
        'Tools: Bloomberg, FactSet, Morningstar, Aladdin — name them explicitly where present.',
        'CFA/IMC progress must appear prominently in education.',
        'Do NOT invent numbers or achievements.',
      ],
      keywordContext: 'AM keywords to inject where contextually appropriate: portfolio management, attribution analysis, AUM, asset allocation, equity research, fixed income, risk management, benchmark, sector analysis, bottom-up, top-down, stock pitch, performance attribution.'
    },
    pe: {
      label: 'Private Equity',
      rules: [
        'CRITICAL: Output must fit on exactly 1 page. PE recruiters expect prior IB/consulting experience front and centre.',
        'Structure: Name + contact → Education → Relevant Experience → Skills. No personal statement.',
        'Education before experience for graduates.',
        'Every bullet past tense action verb.',
        'Deal exposure is everything: name deal sizes, your workstream (financial modelling, due diligence, management presentations), and transaction type (buyout, growth equity, add-on).',
        'Quantify returns where present: IRR, MOIC, ROIC.',
        'LBO modelling, due diligence, and portfolio company work must be explicit where present in the original.',
        'Do NOT invent transactions or returns.',
      ],
      keywordContext: 'PE keywords to inject where contextually appropriate: LBO, due diligence, deal sourcing, portfolio company, IRR, MOIC, capital structure, investment thesis, financial modelling, exit strategy, add-on acquisition.'
    },
    hf: {
      label: 'Hedge Funds',
      rules: [
        'Output should be 1 page. Hedge fund CVs reward differentiated thinking and quantitative rigour.',
        'Structure: Name + contact → Education → Relevant Experience → Skills.',
        'A 2-line summary is appropriate if it conveys a specific strategy or investment philosophy.',
        'Every bullet past tense action verb.',
        'Quantitative skills (Python, statistics, backtesting) must be explicit where present.',
        'Investment thesis or personal portfolio experience should be highlighted if mentioned.',
        'Strategy exposure (long/short, macro, quant, event-driven) must be named explicitly.',
        'Do NOT invent returns or strategies.',
      ],
      keywordContext: 'HF keywords to inject where contextually appropriate: long/short equity, macro, quantitative analysis, alpha generation, portfolio construction, risk management, derivatives, backtesting, investment thesis, position sizing.'
    },
    er: {
      label: 'Equity Research',
      rules: [
        'Output should be 1 page.',
        'Structure: Name + contact → Education → Relevant Experience → Skills.',
        'CFA progress must be prominent.',
        'Sector specialism must be explicit — if the candidate covers a sector, name it.',
        'Written analysis (initiation reports, earnings models, research notes) must be highlighted where present.',
        'Every bullet past tense action verb.',
        'Modelling skills and tools (Bloomberg, FactSet, Excel) must be explicit.',
        'Do NOT invent coverage or reports.',
      ],
      keywordContext: 'ER keywords to inject where contextually appropriate: equity research, sector coverage, financial modelling, initiation report, earnings model, DCF, comparable analysis, CFA, Bloomberg, FactSet, written communication, rating.'
    },
    cf: {
      label: 'Corporate Finance / FP&A',
      rules: [
        'Output should be 1-2 pages.',
        'A 2-3 line professional summary is appropriate, mentioning scope (e.g. regions, business units supported).',
        'Structure: Name + contact → Summary → Experience → Education → Skills.',
        'Every bullet past tense action verb.',
        'Budget sizes, forecast accuracy, and cost savings must be quantified where mentioned.',
        'Business partnering scope (which functions/regions) must be clear.',
        'Tools: Excel, SAP, Oracle, Hyperion, Power BI — name what is in the original.',
        'Do NOT invent budget figures.',
      ],
      keywordContext: 'CF/FP&A keywords to inject where contextually appropriate: FP&A, budgeting, forecasting, variance analysis, business partnering, financial modelling, management accounts, P&L, cash flow, KPI, board reporting.'
    }
  };

  const sector = sectorRules[industry] || sectorRules.am;
  const rulesText = sector.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const kwText = missingKeywords && missingKeywords.length > 0
    ? `\nMissing keywords to integrate naturally: ${missingKeywords.slice(0, 8).join(', ')}\n${sector.keywordContext}`
    : sector.keywordContext;
  const jdSection = jdText && jdText.length > 50
    ? `\n\nJOB DESCRIPTION — tailor every line to match this language:\n${jdText.substring(0, 1500)}`
    : '';
  const roleLabel = jobRole || sector.label;

  const prompt = `You are a specialist ${sector.label} CV writer. You have spent 15 years helping candidates land roles at Goldman Sachs, BlackRock, KKR, Bridgewater, and similar firms. You know exactly what ${sector.label} recruiters look for and reject in the first 30 seconds.

Your task: rewrite the CV below for a ${roleLabel} role.

HARD FORMATTING RULES — follow every single one:
${rulesText}

KEYWORD INTEGRATION:
${kwText}
Integrate keywords ONLY where they naturally belong in an existing bullet point. Do NOT add them to a separate "keywords" section or force them where they do not fit. If a keyword cannot be integrated naturally, omit it.

OUTPUT FORMAT:
- Plain text only — zero markdown, zero asterisks, zero # symbols, zero bold markers
- Section headings in ALL CAPS followed by a line break
- Bullet points use the • character
- Name on first line, contact details on second line
- Blank line between sections
- This must be a COMPLETE, SUBMISSION-READY CV — not a framework, not a template, not a draft${jdSection}

ORIGINAL CV:
${cvText.substring(0, 3500)}

Begin output now with the candidate's name on the first line. Do not include any preamble, explanation, or commentary — output the CV only:`;

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

    if (!rewriteText || rewriteText.length < 200) {
      return res.status(500).json({ error: 'Empty rewrite response' });
    }

    // Return the rewrite plus which rules were applied — shown to user as transparency
    return res.status(200).json({
      success: true,
      rewriteText,
      appliedRules: sector.rules,
      sectorLabel: sector.label
    });

  } catch (err) {
    console.error('Rewrite error:', err);
    return res.status(500).json({ error: 'Rewrite failed', details: err.message });
  }
}
