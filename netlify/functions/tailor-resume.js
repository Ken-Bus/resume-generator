exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'API key not configured' })
    };
  }

  try {
    const { resumeData, jobDescription } = JSON.parse(event.body);

    if (!jobDescription || !jobDescription.trim()) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No job description provided' })
      };
    }

    const prompt = `You are a resume tailoring assistant. You will be given a candidate's resume as structured JSON, and a target job description. Your job:

1. Rewrite the "summary.bullets", "summary.skills", and each experience entry's "bullets" to naturally emphasize skills, keywords, and phrasing that match the job description — WITHOUT inventing new experience, employers, titles, or fabricating anything not implied by the original resume. Keep facts (dates, companies, titles, degrees) exactly as given.
2. Keep the exact same JSON schema/structure as the input resume — only the wording of bullets, tagline, and skills should change.
3. Also produce a "matchSummary" object with: "matchedKeywords" (array of strings — keywords/skills from the job description that ARE reflected in the resume), "missingKeywords" (array of strings — important keywords/skills from the job description that are NOT present in the candidate's background and could not be truthfully added), and "notes" (a short 1-2 sentence plain-English summary of overall fit).

Return ONLY valid JSON, no markdown fences, in this exact shape:
{"resume": <the full resume object with the same schema as input, bullets/summary/skills rewritten>, "matchSummary": {"matchedKeywords":["string"],"missingKeywords":["string"],"notes":"string"}}

Resume JSON:
${JSON.stringify(resumeData)}

Job description:
${jobDescription}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const raw = data.content?.[0]?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: clean })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
