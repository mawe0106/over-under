// Supabase Edge Function: estimate-volume
// The Eagle Eye 👁️ judge. Receives a compressed JPEG of a poured glass,
// asks Claude Sonnet vision for {glass_type, capacity_ml, fill_percent,
// estimated_ml} and returns it. The photo lives only for the duration of
// this request — it is never stored anywhere.
//
// Deploy:  supabase functions deploy estimate-volume --project-ref nvpgopnhpfpapgmeiwsx
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref nvpgopnhpfpapgmeiwsx

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `You estimate the volume of liquid in a drinking glass from a photo, for a party game. Common context: Dutch/European glasses (vaasje ~250ml, fluitje ~180-200ml, pint ~500ml, weizen ~500ml, stein ~1000ml, shot ~35ml, ordinary water/longdrink glass ~200-350ml, wine glass ~150-450ml), but any glass can appear.

Reason briefly, step by step:
1. Identify the glass type and its total capacity in ml. Use scale clues (hands, table, bottles, coasters) — don't assume beer-glass capacity for an ordinary water glass.
2. Locate the liquid's fill line. Beware perspective: photos taken from above make a glass look fuller than it is — prefer the far-side fill line. For clear liquids (water), look for the meniscus and refraction edges carefully.
3. Convert fill HEIGHT to fill VOLUME. Most glasses taper narrower toward the bottom, so liquid up to half the height is typically only 35-45% of the volume. Only a true cylinder maps height 1:1 to volume.
4. milliliters = capacity_ml × volume fraction. People systematically overestimate liquid in glasses — when torn between two values, choose the lower one.

After your brief reasoning, end your reply with exactly ONE JSON object on the final line, no markdown fences:
{"glass_type": "<short name>", "capacity_ml": <int>, "fill_percent": <int 0-100, volume percent>, "estimated_ml": <int>}

If no glass with liquid is clearly visible, end with exactly:
{"error": "no_glass"}`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  // abuse guards: size cap + sane room code before we touch the AI
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (contentLength > 1_500_000) {
    return json(413, { error: 'too_large', message: 'That photo is too big — try again.' });
  }

  let body: { image?: unknown; room_code?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'bad_json' });
  }

  const image = body.image;
  const roomCode = body.room_code;
  if (typeof image !== 'string' || image.length < 100) {
    return json(400, { error: 'missing_image' });
  }
  if (image.length > 1_500_000) {
    return json(413, { error: 'too_large', message: 'That photo is too big — try again.' });
  }
  // 4 uppercase letters — real room codes and the solo sentinel "SOLO" both match
  if (typeof roomCode !== 'string' || !/^[A-Z]{4}$/.test(roomCode)) {
    return json(400, { error: 'bad_room_code' });
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return json(500, { error: 'not_configured', message: 'ANTHROPIC_API_KEY secret is not set.' });
  }

  let upstream: Response;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Sonnet over Haiku: volume-from-photo needs the spatial reasoning.
        // Still ~1-2 cents per photo at party image sizes. Note: Sonnet 5
        // rejects sampling params (temperature etc.) and thinks adaptively
        // by default, so max_tokens includes thinking headroom.
        model: 'claude-sonnet-5',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: 'Estimate the liquid volume in this glass. Reason step by step, then end with the JSON object.' },
          ],
        }],
      }),
    });
  } catch {
    return json(502, { error: 'upstream_unreachable', message: 'Could not reach the AI — try again.' });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error('anthropic error', upstream.status, detail.slice(0, 300));
    return json(502, { error: 'upstream_error', message: 'The AI had a hiccup — try again.' });
  }

  const data = await upstream.json();
  // adaptive thinking means content may start with a thinking block —
  // take the text block, not content[0]
  const textBlock = Array.isArray(data?.content)
    ? data.content.find((b: { type?: string }) => b?.type === 'text')
    : null;
  const raw = String(textBlock?.text ?? '').trim();
  // the model reasons first and ends with one JSON object — take the last {...}
  const start = raw.lastIndexOf('{');
  const end = raw.lastIndexOf('}');
  const text = start >= 0 && end > start ? raw.slice(start, end + 1) : '';

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('unparseable model output', raw.slice(-300));
    return json(502, { error: 'bad_model_output', message: 'The AI mumbled — try another photo.' });
  }

  if (parsed.error === 'no_glass') {
    return json(422, { error: 'no_glass', message: 'No glass with liquid in sight — retake the photo.' });
  }

  const estimate = {
    glass_type: String(parsed.glass_type ?? 'glass').slice(0, 40),
    capacity_ml: Math.round(Number(parsed.capacity_ml) || 0),
    fill_percent: Math.max(0, Math.min(100, Math.round(Number(parsed.fill_percent) || 0))),
    estimated_ml: Math.round(Number(parsed.estimated_ml) || 0),
  };
  if (estimate.estimated_ml < 5 || estimate.estimated_ml > 5000) {
    return json(422, { error: 'no_glass', message: 'That doesn’t look like a drinkable amount — retake the photo.' });
  }

  return json(200, estimate);
});
