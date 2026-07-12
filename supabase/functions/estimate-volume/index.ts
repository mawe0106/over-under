// Supabase Edge Function: estimate-volume
// The Eagle Eye 👁️ judge. Receives a compressed JPEG of a poured glass,
// asks Claude Haiku vision for {glass_type, capacity_ml, fill_percent,
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

const SYSTEM_PROMPT = `You estimate the volume of liquid in a drinking glass from a photo, for a party game. Common context: Dutch/European beer glasses (vaasje ~250ml, fluitje ~180-200ml, pint ~500ml, weizen ~500ml, stein ~1000ml, shot ~35ml), but any glass can appear.

Identify the most likely glass type and total capacity, estimate what fraction is filled with liquid, and compute the milliliters of liquid.

Respond with ONLY a JSON object, no markdown fences, no other text:
{"glass_type": "<short name>", "capacity_ml": <int>, "fill_percent": <int 0-100>, "estimated_ml": <int>}

If no glass with liquid is clearly visible, respond with exactly:
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: 'Estimate the liquid volume in this glass.' },
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
  const text = String(data?.content?.[0]?.text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('unparseable model output', text.slice(0, 200));
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
