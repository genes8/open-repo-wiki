// Self-contained endpoint probes. NOTE: this module must NOT import engine code
// (the engine is a separate CJS process); API key values stay in memory only —
// they are passed in as arguments and must never be logged.
export async function probeOpenAI(baseUrl: string, apiKey: string, model: string, timeoutMs = 20000): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'say ok' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return res.ok && text.includes('"content"') ? { ok: true } : { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  } catch (err) { return { ok: false, error: String((err as Error).message || err).slice(0, 160) }; }
}

export async function probeAnthropic(baseUrl: string, apiKey: string, model: string, timeoutMs = 20000): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'say ok' }], max_tokens: 16, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return res.ok && text.includes('"text"') ? { ok: true } : { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  } catch (err) { return { ok: false, error: String((err as Error).message || err).slice(0, 160) }; }
}

export async function probeOllama(baseUrl: string, model: string, timeoutMs = 10000): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'say ok' }], stream: false, think: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  } catch (err) { return { ok: false, error: String((err as Error).message || err).slice(0, 160) }; }
}
