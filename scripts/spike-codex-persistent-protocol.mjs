import { randomUUID } from "node:crypto";
import {
  createJsonRpcClient,
  makeProbeRepo,
  removeProbeRepo,
  requireCliPath,
  requireLiveProbeOptIn,
  spawnNdjsonProcess,
  waitForNotification,
} from "./cli-probe-helpers.mjs";

const TURN_TIMEOUT_MS = Number(process.env.FORGE_CLI_PROBE_TIMEOUT_MS ?? 180_000);

function textInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

async function initialize(client) {
  await client.request("initialize", {
    clientInfo: { name: "forge-cli-probe", title: "Forge CLI Probe", version: "1" },
    capabilities: null,
  });
  client.notify("initialized");
}

async function runTurn(client, threadId, prompt) {
  const deltas = [];
  const completed = waitForNotification(
    client,
    (message) =>
      message.method === "turn/completed" && message.params?.threadId === threadId,
    TURN_TIMEOUT_MS,
    "Codex turn/completed",
  );
  const unsubscribe = client.onNotification((message) => {
    if (
      message.method === "item/agentMessage/delta" &&
      message.params?.threadId === threadId &&
      typeof message.params.delta === "string"
    ) {
      deltas.push(message.params.delta);
    }
  });
  try {
    const started = await client.request("turn/start", {
      threadId,
      input: textInput(prompt),
    });
    const terminal = await completed;
    return { started, terminal, text: deltas.join(""), deltaCount: deltas.length };
  } finally {
    unsubscribe();
  }
}

async function inspectMcp(executable, directory) {
  const handle = spawnNdjsonProcess(executable, ["mcp-server"], directory);
  const client = createJsonRpcClient(handle, 30_000, true);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "forge-cli-probe", version: "1" },
    });
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list", {});
    return {
      protocolVersion: initialized?.protocolVersion,
      tools: Array.isArray(listed?.tools) ? listed.tools.map((tool) => tool.name) : [],
    };
  } finally {
    handle.closeInput();
    await handle.waitForExit().catch(() => handle.terminate());
  }
}

async function main() {
  requireLiveProbeOptIn();
  const executable = requireCliPath("CODEX_CLI");
  const directory = await makeProbeRepo("forge-codex-app-server-");
  const nonce = `FORGE-${randomUUID()}`;
  let handle;

  try {
    handle = spawnNdjsonProcess(
      executable,
      ["app-server", "--stdio", "-c", "analytics.enabled=false"],
      directory,
    );
    const client = createJsonRpcClient(handle, TURN_TIMEOUT_MS);
    await initialize(client);

    const threadResponse = await client.request("thread/start", {
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
    });
    const threadId = threadResponse?.thread?.id;
    if (typeof threadId !== "string") throw new Error("thread/start returned no thread id.");

    const first = await runTurn(
      client,
      threadId,
      `Remember this exact nonce: ${nonce}. Reply only with REMEMBERED.`,
    );
    const second = await runTurn(
      client,
      threadId,
      "Return the exact nonce from the previous turn. Reply with only the nonce.",
    );
    if (!second.text.includes(nonce)) throw new Error("Codex warm thread lost turn context.");
    if (first.deltaCount === 0 || second.deltaCount === 0) {
      throw new Error("Codex app-server emitted no agent-message streaming deltas.");
    }

    const cancelTurnStarted = waitForNotification(
      client,
      (message) =>
        message.method === "turn/started" && message.params?.threadId === threadId,
      30_000,
      "interrupt-test turn/started",
    );
    const commandStarted = waitForNotification(
      client,
      (message) =>
        message.method === "item/started" &&
        message.params?.threadId === threadId &&
        message.params?.item?.type === "commandExecution",
      60_000,
      "interrupt-test commandExecution item/started",
    );
    const cancelled = waitForNotification(
      client,
      (message) =>
        message.method === "turn/completed" &&
        message.params?.threadId === threadId,
      TURN_TIMEOUT_MS,
      "cancelled Codex turn/completed",
    );
    const cancelStartRequest = client.request("turn/start", {
      threadId,
      input: textInput(
        'Execute this exact command and wait for it to finish: powershell -NoProfile -Command "Start-Sleep -Seconds 30". Then reply DONE.',
      ),
    });
    const startedNotification = await cancelTurnStarted;
    const cancelTurnId = startedNotification.params?.turn?.id;
    if (typeof cancelTurnId !== "string") {
      throw new Error("turn/started returned no turn id.");
    }
    await commandStarted;
    await client.request("turn/interrupt", { threadId, turnId: cancelTurnId });
    await cancelStartRequest;
    const cancelledResult = await cancelled;

    handle.closeInput();
    await handle.waitForExit();
    handle = undefined;

    const mcp = await inspectMcp(executable, directory);
    console.log(
      JSON.stringify(
        {
          passed: true,
          cli: "codex",
          selectedTransport: "app-server",
          threadId,
          streamingDeltaCounts: [first.deltaCount, second.deltaCount],
          warmContextPersisted: true,
          interruptTerminalStatus: cancelledResult.params?.turn?.status ?? null,
          mcpSurface: mcp,
          reason:
            "app-server exposes native thread/turn lifecycle, streaming deltas, completion, and interruption",
        },
        null,
        2,
      ),
    );
  } finally {
    if (handle) await handle.terminate().catch(() => {});
    await removeProbeRepo(directory);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ passed: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
