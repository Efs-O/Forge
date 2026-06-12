// Live OpenRouter free-model probe.
//
// Fetches the current model catalog from OpenRouter, filters to free routes,
// then sends a tiny chat completion to each model and reports the result.
//
// Run (PowerShell):
//   $env:OPENROUTER_API_KEY = "sk-or-v1-..."
//   node scripts/ping-openrouter-free-models.mjs
//
// Optional env vars:
//   OPENROUTER_DELAY_MS=1200   # delay between probes
//   OPENROUTER_LIMIT=10        # probe only the first N free models

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error('Set OPENROUTER_API_KEY first. Aborting.');
  process.exit(1);
}

const API_BASE = 'https://openrouter.ai/api/v1';
const DELAY_MS = Number.parseInt(process.env.OPENROUTER_DELAY_MS ?? '1200', 10);
const LIMIT = Number.parseInt(process.env.OPENROUTER_LIMIT ?? '0', 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.OPENROUTER_TIMEOUT_MS ?? '12000', 10);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function authHeaders() {
  return {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
  };
}

function isFreeModel(model) {
  const id = typeof model?.id === 'string' ? model.id : '';
  return id === 'openrouter/free' || id.endsWith(':free');
}

async function fetchFreeModels() {
  const res = await fetch(`${API_BASE}/models`, {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Models API failed: HTTP ${res.status} ${await res.text()}`);
  }

  const payload = await res.json();
  const models = Array.isArray(payload?.data) ? payload.data : [];
  return models
    .filter(isFreeModel)
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextLength: model.context_length ?? null,
      pricing: model.pricing ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));
}

async function pingModel(modelId) {
  const started = Date.now();
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    });

    const ms = Date.now() - started;
    const bodyText = await res.text().catch(() => '');
    if (res.ok) {
      let routedModel = '';
      try {
        const parsed = JSON.parse(bodyText);
        routedModel = typeof parsed?.model === 'string' ? parsed.model : '';
      } catch {
        // Ignore parse failures; the HTTP status is enough for the probe.
      }
      return { ok: true, status: res.status, ms, routedModel };
    }

    const reason = res.status === 429 ? 'rate-limited upstream' : bodyText.slice(0, 160);
    return { ok: false, status: res.status, ms, reason };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      reason: `network error - ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const allFreeModels = await fetchFreeModels();
const modelsToProbe = LIMIT > 0 ? allFreeModels.slice(0, LIMIT) : allFreeModels;

console.log(`Found ${allFreeModels.length} free models; probing ${modelsToProbe.length}.`);

for (const model of modelsToProbe) {
  const result = await pingModel(model.id);
  if (result.ok) {
    const routedSuffix = result.routedModel ? ` -> ${result.routedModel}` : '';
    console.log(`OK    ${String(result.ms).padStart(5)}ms  ${model.id}${routedSuffix}`);
  } else {
    console.log(
      `FAIL  ${String(result.ms).padStart(5)}ms  ${model.id}  HTTP ${result.status}  ${result.reason}`,
    );
  }
  await delay(DELAY_MS);
}
