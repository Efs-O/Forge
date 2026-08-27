/**
 * Send one short chat to every Ollama *cloud* catalog model defined in
 * .forge/config.yaml (F6 models-vs-profiles shape: `models` is an array).
 * Cloud rows are detected by `group: ollama-local` plus a :cloud / -cloud name.
 *
 * Usage:
 *   node scripts/ping-ollama-cloud-models.mjs [path/to/config.yaml] [--prompt "your question"]
 *
 * Env:
 *   PING_PROMPT  — default question if --prompt omitted
 *   PING_TIMEOUT_MS — per-request timeout (default 120000)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function isOllamaCloudKey(name) {
  return name.includes(":cloud") || name.endsWith("-cloud");
}

function normalizeEndpoint(url) {
  if (!url || typeof url !== "string") return "http://127.0.0.1:11434";
  return url.replace(/\/$/, "");
}

function parseArgs(argv) {
  const out = {
    configPath: path.join(REPO_ROOT, ".forge", "config.yaml"),
    prompt: process.env.PING_PROMPT ?? "Reply with exactly: OK",
    timeoutMs: Number(process.env.PING_TIMEOUT_MS ?? 120_000) || 120_000,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt" && argv[i + 1]) {
      out.prompt = argv[++i];
      continue;
    }
    if (a === "--timeout" && argv[i + 1]) {
      out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
      continue;
    }
    if (!a.startsWith("-")) rest.push(a);
  }
  if (rest[0]) out.configPath = path.resolve(rest[0]);
  return out;
}

function buildRequest(modelName, cfg, prompt) {
  const sampling = cfg?.sampling && typeof cfg.sampling === "object" ? cfg.sampling : {};
  const stop = Array.isArray(sampling.stop) ? sampling.stop : sampling.stop !== undefined ? [sampling.stop] : undefined;
  const repeatPenalty = sampling.repeat_penalty ?? sampling.repetition_penalty;
  const think =
    cfg?.think === false || cfg?.reasoning_effort === "none"
      ? false
      : cfg?.think === true
        ? (cfg?.reasoning_effort === "high" || cfg?.reasoning_effort === "medium" || cfg?.reasoning_effort === "low"
          ? cfg.reasoning_effort
          : true)
        : undefined;
  return {
    model: modelName,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    ...(think !== undefined ? { think } : {}),
    options: {
      ...(cfg?.num_ctx !== undefined ? { num_ctx: cfg.num_ctx } : {}),
      ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling.top_p !== undefined ? { top_p: sampling.top_p } : {}),
      ...(sampling.top_k !== undefined ? { top_k: sampling.top_k } : {}),
      ...(sampling.min_p !== undefined ? { min_p: sampling.min_p } : {}),
      ...(sampling.max_tokens !== undefined ? { num_predict: sampling.max_tokens } : { num_predict: 64 }),
      ...(sampling.seed !== undefined ? { seed: sampling.seed } : {}),
      ...(sampling.presence_penalty !== undefined ? { presence_penalty: sampling.presence_penalty } : {}),
      ...(sampling.frequency_penalty !== undefined ? { frequency_penalty: sampling.frequency_penalty } : {}),
      ...(repeatPenalty !== undefined ? { repeat_penalty: repeatPenalty } : {}),
      ...(sampling.repeat_last_n !== undefined ? { repeat_last_n: sampling.repeat_last_n } : {}),
      ...(stop !== undefined ? { stop } : {}),
    },
  };
}

function extractPreview(text) {
  let snippet = text;
  try {
    const json = JSON.parse(text);
    const message = json?.message;
    const content = typeof message?.content === "string" ? message.content : "";
    const reasoning = typeof message?.thinking === "string" ? message.thinking : "";
    const piece = content.trim() || reasoning.trim() || json?.error?.message || text;
    snippet = typeof piece === "string" ? piece : JSON.stringify(piece);
  } catch {
    // keep raw
  }
  return snippet.slice(0, 280);
}

async function chatOnce(baseUrl, request, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, preview: text.slice(0, 500) };
    }
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const lastLine = lines.at(-1) ?? text;
    return { ok: true, status: res.status, preview: extractPreview(lastLine) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      preview: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const { configPath, prompt, timeoutMs } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(configPath)) {
    console.error(`Forge: config file not found: ${configPath}`);
    process.exitCode = 1;
    return;
  }

  const doc = yaml.load(fs.readFileSync(configPath, "utf8"));
  const modelsBlock = doc?.models;
  if (!Array.isArray(modelsBlock)) {
    console.error("Forge: config.yaml has no models array (expected F6 models-vs-profiles shape)");
    process.exitCode = 1;
    return;
  }

  const cloudRows = modelsBlock
    .filter((cfg) => cfg?.group === "ollama-local" && isOllamaCloudKey(cfg?.name))
    .map((cfg) => [cfg.name, cfg]);

  if (cloudRows.length === 0) {
    console.error("Forge: no Ollama cloud models found (group: ollama-local, name containing :cloud or ending with -cloud)");
    process.exitCode = 1;
    return;
  }

  console.log(`Config: ${configPath}`);
  console.log(`Prompt: ${prompt}`);
  console.log(`Models: ${cloudRows.length} (cloud only)\n`);

  for (const [name, cfg] of cloudRows) {
    const base = normalizeEndpoint(cfg?.endpoint);
    const request = buildRequest(name, cfg, prompt);
    process.stdout.write(`${name} ... `);
    const r = await chatOnce(base, request, timeoutMs);
    if (r.ok) {
      console.log(`OK (${r.status})\n  ${r.preview.replace(/\s+/g, " ").trim()}\n`);
    } else {
      console.log(`FAIL (${r.status})\n  ${r.preview}\n`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
