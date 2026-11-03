const MODEL = 'gemini-3.8-flash';

export default async (request) => {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Missing GEMINI_API_KEY environment variable');
    return Response.json({ error: 'api_key_missing' }, { status: 500 });
  }

  try {
    const raw = await request.text();
    if (raw.length > 8_000_000) {
      return Response.json({ error: 'request_too_large' }, { status: 413 });
    }

    const body = JSON.parse(raw);
    const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 12000) : '';
    if (!prompt.trim()) {
      return Response.json({ error: 'missing_prompt' }, { status: 400 });
    }

    const parts = [{ text: prompt }];
    if (body.image) {
      const mimeType = ['image/jpeg', 'image/png', 'image/webp'].includes(body.image.mimeType)
        ? body.image.mimeType : null;
      const data = typeof body.image.data === 'string' ? body.image.data : '';
      if (!mimeType || !data || data.length > 7_500_000 || !/^[A-Za-z0-9+/=]+$/.test(data)) {
        return Response.json({ error: 'invalid_image' }, { status: 400 });
      }
      parts.push({ inlineData: { mimeType, data } });
    }

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                items: {
                  type: 'ARRAY',
                  maxItems: 8,
                  items: {
                    type: 'OBJECT',
                    properties: {
                      name: { type: 'STRING' },
                      portion: { type: 'STRING' },
                      kcal: { type: 'INTEGER' },
                      groups: { type: 'ARRAY', items: { type: 'STRING' } },
                      fruit_veg_g: { type: 'INTEGER' },
                      sweet: { type: 'BOOLEAN' },
                      salty: { type: 'BOOLEAN' },
                    },
                    required: ['name', 'portion', 'kcal', 'groups', 'fruit_veg_g', 'sweet', 'salty'],
                  },
                },
                note: { type: 'STRING' },
              },
              required: ['items', 'note'],
            },
          },
        }),
      },
    );

    const result = await geminiResponse.json();
    if (!geminiResponse.ok) {
      console.error('Gemini API error:', geminiResponse.status, result?.error?.message || 'unknown');
      return Response.json({ error: 'gemini_request_failed' }, { status: 502 });
    }

    const text = result?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('');
    if (!text) return Response.json({ error: 'empty_completion' }, { status: 502 });

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 502 });
    }

    const items = Array.isArray(parsed.items) ? parsed.items.slice(0, 8).map((item) => ({
      name: String(item?.name || '').slice(0, 60),
      portion: String(item?.portion || '').slice(0, 40),
      kcal: Math.max(0, Math.min(3000, Math.round(Number(item?.kcal) || 0))),
      groups: Array.isArray(item?.groups) ? item.groups.filter((group) => ['grain', 'protein', 'veg', 'fruit', 'dairy', 'legume'].includes(group)) : [],
      fruit_veg_g: Math.max(0, Math.min(2000, Math.round(Number(item?.fruit_veg_g) || 0))),
      sweet: Boolean(item?.sweet),
      salty: Boolean(item?.salty),
    })).filter((item) => item.name && item.kcal > 0) : [];

    return Response.json({ items, note: String(parsed.note || '').slice(0, 240) });
  } catch (error) {
    console.error('estimate-food function failed:', error);
    return Response.json({ error: 'request_failed' }, { status: 500 });
  }
};
