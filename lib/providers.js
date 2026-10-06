'use strict';
/**
 * AI backend providers with a single unified entry point: chat(profile, messages, opts).
 *  - openai    : any OpenAI-compatible /chat/completions endpoint
 *                (Ollama :11434/v1, LM Studio :1234/v1, llama.cpp server :8080/v1,
 *                 vLLM, or online: Zhipu GLM, Moonshot Kimi, ...)
 *  - anthropic : Anthropic-compatible /v1/messages endpoint (Zhipu GLM Coding
 *                Plan quota lives here: open.bigmodel.cn/api/anthropic)
 *  - ollama    : native Ollama /api/chat endpoint
 *  - llamacpp  : GGUF model loaded in-process via node-llama-cpp (no server at all)
 */

function resolveApiKey(raw) {
  if (!raw) return '';
  if (raw.startsWith('env:')) return process.env[raw.slice(4)] || '';
  return raw;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Stalled upstream connections would otherwise hang a run forever: bound every
// HTTP request with an abort timer (configurable per profile via timeoutMs).
function requestTimeout(profile, opts) {
  const ms = Number(opts.timeoutMs ?? profile.timeoutMs ?? 300000);
  return Number.isFinite(ms) && ms > 0 ? AbortSignal.timeout(ms) : undefined;
}

// Reasoning models can leak their chain-of-thought into the answer as
// <think>...</think> blocks (qwen3/glm/deepseek-r1 over various servers).
function stripThink(text) {
  let out = String(text);
  const leading = /^\s*<think>[\s\S]*?<\/think>\s*/;
  while (leading.test(out)) out = out.replace(leading, '');
  return out.trim();
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
    signal: requestTimeout(profile, opts),
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
  const choice = data.choices && data.choices[0];
  return {
    content,
    finishReason: choice && choice.finish_reason ? choice.finish_reason : null,
    usage: data.usage && typeof data.usage === 'object' ? data.usage : null,
  };
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
  const hasPromptTokens = Number.isFinite(data.prompt_eval_count);
  const hasCompletionTokens = Number.isFinite(data.eval_count);
  return {
    content,
    finishReason: data.done_reason || null,
    usage: hasPromptTokens || hasCompletionTokens
      ? {
          ...(hasPromptTokens ? { prompt_tokens: data.prompt_eval_count } : {}),
          ...(hasCompletionTokens ? { completion_tokens: data.eval_count } : {}),
        }
      : null,
  };
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
    console.error(`  loading GGUF model: ${profile.modelPath}`);
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
    const response = await session.prompt(user, {
      maxTokens: opts.maxTokens ?? profile.maxTokens ?? 4096,
      temperature: opts.temperature ?? profile.temperature ?? 0.3,
    });
    const content = stripThink(response);
    if (!content) throw new Error('empty completion from in-process llama.cpp');
    return {
      content,
      finishReason: 'stop',
      usage: null,
    };
  } finally {
    await context.dispose();
  }
}

// Anthropic Messages API (also spoken by Zhipu's GLM Coding Plan endpoint).
// Thinking models return content blocks; only "text" blocks carry the answer,
// "thinking" blocks are reasoning and must not leak into page markdown.
async function chatAnthropic(profile, messages, opts) {
  const url = String(profile.baseUrl).replace(/\/+$/, '') + '/v1/messages';
  const apiKey = resolveApiKey(profile.apiKey);
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const convo = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: profile.model,
      ...(system ? { system } : {}),
      messages: convo,
      max_tokens: opts.maxTokens ?? profile.maxTokens ?? 4096,
      ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    }),
    signal: requestTimeout(profile, opts),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`HTTP ${res.status} from ${url}: ${body}`);
  }
  const data = await res.json();
  const content = (Array.isArray(data.content) ? data.content : [])
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
  if (!content) {
    throw new Error(`empty completion from ${url} (no text blocks — thinking consumed the max_tokens budget? raise it)`);
  }
  const finish = data.stop_reason === 'max_tokens' ? 'length'
    : data.stop_reason === 'end_turn' ? 'stop'
      : (data.stop_reason || null);
  return {
    content: stripThink(content),
    finishReason: finish,
    usage: data.usage && typeof data.usage === 'object' ? {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
    } : null,
  };
}

const PROVIDERS = { openai: chatOpenAI, anthropic: chatAnthropic, ollama: chatOllama, llamacpp: chatLlamaCpp };

async function chatDetailed(profile, messages, opts = {}) {
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

async function chat(profile, messages, opts = {}) {
  return (await chatDetailed(profile, messages, opts)).content;
}

module.exports = {
  chat,
  chatDetailed,
  resolveApiKey,
  PROVIDERS,
  stripThink,
};
