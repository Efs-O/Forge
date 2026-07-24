import { randomUUID } from "node:crypto";
import {
  makeProbeRepo,
  removeProbeRepo,
  requireCliPath,
  requireLiveProbeOptIn,
  spawnNdjsonProcess,
  waitForMessage,
} from "./cli-probe-helpers.mjs";

const TURN_TIMEOUT_MS = Number(process.env.FORGE_CLI_PROBE_TIMEOUT_MS ?? 180_000);

function claudeArgs(sessionId, resume) {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "plan",
    "--setting-sources",
    "project,local",
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
  ];
}

function userMessage(text) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function resultText(message) {
  return message?.type === "result" && typeof message.result === "string" ? message.result : "";
}

async function sendTurn(handle, text) {
  const resultPromise = waitForMessage(
    handle,
    (message) => message?.type === "result",
    TURN_TIMEOUT_MS,
    "Claude result",
  );
  handle.send(userMessage(text));
  const result = await resultPromise;
  if (result.is_error) throw new Error(result.result || "Claude returned an error result.");
  return result;
}

async function main() {
  requireLiveProbeOptIn();
  const executable = requireCliPath("CLAUDE_CLI");
  const directory = await makeProbeRepo("forge-claude-cold-resume-");
  const requestedSessionId = randomUUID();
  const nonce = `FORGE-${randomUUID()}`;
  const report = {
    cli: "claude",
    requestedSessionId,
    completedTurnPersisted: false,
    interruptedTurnSurfaced: false,
    earlierContextSurvivedMidTurnCrash: false,
  };
  let handle;

  try {
    handle = spawnNdjsonProcess(executable, claudeArgs(requestedSessionId, false), directory);
    const first = await sendTurn(
      handle,
      `Remember this exact nonce for later: ${nonce}. Reply only with REMEMBERED.`,
    );
    const sessionId =
      typeof first.session_id === "string" ? first.session_id : requestedSessionId;
    report.sessionId = sessionId;

    await handle.terminate();
    handle = spawnNdjsonProcess(executable, claudeArgs(sessionId, true), directory);
    const recalled = await sendTurn(
      handle,
      "Return the exact nonce I asked you to remember. Reply with only the nonce.",
    );
    report.completedTurnPersisted = resultText(recalled).includes(nonce);
    if (!report.completedTurnPersisted) {
      throw new Error("Claude did not recover completed-turn context after process death.");
    }

    const assistantEvent = waitForMessage(
      handle,
      (message) => message?.type === "assistant",
      TURN_TIMEOUT_MS,
      "Claude assistant output before forced crash",
    );
    handle.send(
      userMessage(
        "Begin a detailed 20-section analysis of software testing. Do not mention the saved nonce.",
      ),
    );
    await assistantEvent;
    await handle.terminate();
    report.interruptedTurnSurfaced = true;

    handle = spawnNdjsonProcess(executable, claudeArgs(sessionId, true), directory);
    const afterCrash = await sendTurn(
      handle,
      "Return the exact nonce from the earlier completed turn. Reply with only the nonce.",
    );
    report.earlierContextSurvivedMidTurnCrash = resultText(afterCrash).includes(nonce);
    if (!report.earlierContextSurvivedMidTurnCrash) {
      throw new Error("Claude lost earlier completed context after a mid-turn crash.");
    }

    handle.closeInput();
    await handle.waitForExit();
    console.log(JSON.stringify({ ...report, passed: true }, null, 2));
  } finally {
    if (handle) await handle.terminate().catch(() => {});
    await removeProbeRepo(directory);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ passed: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
