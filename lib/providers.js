'use strict';
/**
 * AI backend providers with a single unified entry point: chat(profile, messages, opts).
 *  - openai   : any OpenAI-compatible /chat/completions endpoint
 *               (Ollama :11434/v1, LM Studio :1234/v1, llama.cpp server :8080/v1,
 *                vLLM, or online: Zhipu GLM, Moonshot Kimi, ...)
 *  - ollama   : native Ollama /api/chat endpoint
 *  - llamacpp : GGUF model loaded in-process via node-llama-cpp (no server at all)
 */

function resolveApiKey(raw) {
  if (!raw) return '';
  if (raw.startsWith('env:')) return process.env[raw.slice(4)] || '';
  return raw;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Reasoning models can leak their chain-of-thought into the answer as
// <think>...</think> blocks (qwen3/glm/deepseek-r1 over various servers).
function stripThink(text) {
  return String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function chatOpenAI(profile, messages, opts) {
  const url = String(profile.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const apiKey = resolveApiKey(profile.apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: profile.model,
      messages,
      temperature: opts.temperature ?? profile.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? profile.maxTokens ?? 4096,
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`HTTP ${res.status} from ${url}: ${body}`);
  }
  const data = await res.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  let content = msg && msg.content ? stripThink(msg.content) : '';
  // Some OpenAI-compatible servers (LM Studio/vLLM with reasoning models) put
  // the whole output into reasoning_content and leave content empty.
  if (!content && msg && msg.reasoning_content) content = stripThink(msg.reasoning_content);
  if (!content) throw new Error(`empty completion from ${url}`);
  return content;
}

async function chatOllama(profile, messages, opts) {
  const url = String(profile.baseUrl || 'http://localhost:11434').replace(/\/+$/, '') + '/api/chat';
  const body = {
    model: profile.model,
    messages,
    stream: false,
    options: {
      temperature: opts.temperature ?? profile.temperature ?? 0.3,
      num_predict: opts.maxTokens ?? profile.maxTokens ?? 4096,
      ...(profile.contextSize ? { num_ctx: profile.contextSize } : {}),
    },
  };
  const post = (payload) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // Thinking models (qwen3, glm, deepseek-r1, ...) burn the token budget on
  // reasoning and return an empty content field — disable thinking by default;
  // fall back to a plain request for models that reject the parameter.
  let res = await post({ ...body, think: profile.think ?? false });
  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 300);
    if (/think/i.test(errText)) {
      res = await post(body);
      if (!res.ok) {
        const body2 = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`HTTP ${res.status} from ${url}: ${body2}`);
      }
    } else {
      throw new Error(`HTTP ${res.status} from ${url}: ${errText}`);
    }
  }
  const data = await res.json();
  const content = data.message && data.message.content ? stripThink(data.message.content) : '';
  if (!content) throw new Error(`empty completion from ${url}`);
  return content;
}

// Direct in-process GGUF inference. node-llama-cpp is ESM-only, loaded lazily so
// the rest of the app has zero dependencies when this provider is unused.
const llamaCache = new Map();
async function chatLlamaCpp(profile, messages, opts) {
  if (!profile.modelPath) throw new Error("provider 'llamacpp' requires a modelPath (path to a .gguf file)");
  let entry = llamaCache.get(profile.modelPath);
  if (!entry) {
    let nlc;
    try {
      nlc = await import('node-llama-cpp');
    } catch {
      throw new Error("node-llama-cpp is not installed. Run: npm install node-llama-cpp");
    }
    const llama = await nlc.getLlama();
    console.log(`  loading GGUF model: ${profile.modelPath}`);
    const model = await llama.loadModel({
      modelPath: profile.modelPath,
      ...(profile.gpuLayers !== undefined ? { gpuLayers: profile.gpuLayers } : {}),
    });
    entry = { nlc, model };
    llamaCache.set(profile.modelPath, entry);
  }
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const user = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
  const context = await entry.model.createContext(
    profile.contextSize ? { contextSize: profile.contextSize } : {}
  );
  try {
    const session = new entry.nlc.LlamaChatSession({
      contextSequence: context.getSequence(),
      ...(system ? { systemPrompt: system } : {}),
    });
    return await session.prompt(user, {
      maxTokens: opts.maxTokens ?? profile.maxTokens ?? 4096,
      temperature: opts.temperature ?? profile.temperature ?? 0.3,
    });
  } finally {
    await context.dispose();
  }
}

const PROVIDERS = { openai: chatOpenAI, ollama: chatOllama, llamacpp: chatLlamaCpp };

async function chat(profile, messages, opts = {}) {
  const fn = PROVIDERS[profile.provider];
  if (!fn) {
    throw new Error(`unknown provider '${profile.provider}' (expected: ${Object.keys(PROVIDERS).join(', ')})`);
  }
  const retries = opts.retries ?? 2;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(profile, messages, opts);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        console.warn(`  retry ${attempt + 1}/${retries}: ${err.message.split('\n')[0]}`);
        await sleep(1500 * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

module.exports = { chat, resolveApiKey, PROVIDERS };
