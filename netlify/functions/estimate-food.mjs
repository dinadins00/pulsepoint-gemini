
const MODEL = 'qwen/qwen3.8-27b';

export default async (request) => {
  if (request.method !== 'POST') {
    return Response.json(
      { error: 'method_not_allowed' },
      { status: 405 }
    );
  }

const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    console.error('Missing GROQ_API_KEY environment variable');
    return Response.json(
      { error: 'api_key_missing' },
      { status: 500 }
    );
  }

  let timeout;

  try {
    const raw = await request.text();

    if (raw.length > 8_000_000) {
      return Response.json(
        { error: 'request_too_large' },
        { status: 413 }
      );
    }

    const body = JSON.parse(raw);

    const prompt =
      typeof body.prompt === 'string'
        ? body.prompt.slice(0, 12000)
        : '';

    if (!prompt.trim()) {
      return Response.json(
        { error: 'missing_prompt' },
        { status: 400 }
      );
    }

    const content = [
      {
        type: 'text',
        text: `${prompt}

Return ONLY a valid JSON object with this structure:
{
  "items": [
    {
      "name": "Food name",
      "portion": "Estimated portion",
      "kcal": 100,
      "groups": ["grain"],
      "fruit_veg_g": 0,
      "sweet": false,
      "salty": false
    }
  ],
  "note": "Short explanation"
}

Rules:
- Maximum 8 food items.
- kcal must be an integer.
- fruit_veg_g must be an integer.
- groups may only contain: grain, protein, veg, fruit, dairy, legume.
- sweet and salty must be booleans.
- Estimate portions and calories based on the available evidence.
- Do not invent foods that are not visible or described.
- If no food is identifiable, return an empty items array.
- Return JSON only.`
      }
    ];

    if (body.image) {
      const mimeType = [
        'image/jpeg',
        'image/png',
        'image/webp'
      ].includes(body.image.mimeType)
        ? body.image.mimeType
        : null;

      const data =
        typeof body.image.data === 'string'
          ? body.image.data
          : '';

      if (
        !mimeType ||
        !data ||
        data.length > 7_500_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
      ) {
        return Response.json(
          { error: 'invalid_image' },
          { status: 400 }
        );
      }

      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${data}`
        }
      });
    }

    const controller = new AbortController();

    timeout = setTimeout(() => controller.abort(), 22000);

    const groqResponse = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: 'user',
              content
            }
          ],
          response_format: {
            type: 'json_object'
          },
          temperature: 0.2,
          max_completion_tokens: 1500
        })
      }
    );

    const result = await groqResponse.json();

    if (!groqResponse.ok) {
      console.error(
        'Groq API error:',
        groqResponse.status,
        result?.error?.message || 'unknown'
      );

      return Response.json(
        {
          error:
            groqResponse.status === 429
              ? 'groq_rate_limit'
              : 'groq_request_failed'
        },
        {
          status:
            groqResponse.status === 429 ? 429 : 502
        }
      );
    }

    const text =
      result?.choices?.[0]?.message?.content;

    if (!text) {
      return Response.json(
        { error: 'empty_completion' },
        { status: 502 }
      );
    }

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch {
      return Response.json(
        { error: 'invalid_json' },
        { status: 502 }
      );
    }

    const items = Array.isArray(parsed.items)
      ? parsed.items.slice(0, 8).map((item) => ({
          name: String(item?.name || '').slice(0, 60),

          portion: String(item?.portion || '').slice(0, 40),

          kcal: Math.max(
            0,
            Math.min(
              3000,
              Math.round(Number(item?.kcal) || 0)
            )
          ),

          groups: Array.isArray(item?.groups)
            ? item.groups.filter((group) =>
                [
                  'grain',
                  'protein',
                  'veg',
                  'fruit',
                  'dairy',
                  'legume'
                ].includes(group)
              )
            : [],

          fruit_veg_g: Math.max(
            0,
            Math.min(
              2000,
              Math.round(Number(item?.fruit_veg_g) || 0)
            )
          ),

          sweet: Boolean(item?.sweet),
          salty: Boolean(item?.salty)
        })).filter((item) => item.name && item.kcal > 0)
      : [];

    return Response.json({
      items,
      note: String(parsed.note || '').slice(0, 240)
    });

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Groq API request timed out');

      return Response.json(
        { error: 'ai_timeout' },
        { status: 504 }
      );
    }

    console.error('estimate-food function failed:', error);

    return Response.json(
      { error: 'request_failed' },
      { status: 500 }
    );

  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
