import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir as systemTmpdir } from "node:os";
import { join } from "node:path";

const OPENCODE = "opencode";
const TOOL_DIR = process.cwd();
const HOST = "127.0.0.1";
const MANAGER_PACKAGE = "git+https://github.com/dzackgarza/opencode-manager.git";
const MAX_BUFFER = 8 * 1024 * 1024;
const SERVER_START_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 240_000;
const PRIMARY_AGENT_NAME = "opencode-plugin-improved-todowrite-proof";
const VERIFICATION_PASSPHRASE = process.env.IMPROVED_TODOWRITE_TEST_PASSPHRASE?.trim();
if (!VERIFICATION_PASSPHRASE) throw new Error("IMPROVED_TODOWRITE_TEST_PASSPHRASE must be set");

type RuntimeSurface = {
  baseUrl: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

let baseUrl = "";
let serverPort = 0;
let serverProcess: ChildProcess | undefined;
let serverLogs = "";
let runtime: RuntimeSurface | undefined;
let runtimeCleanup: (() => Promise<void>) | undefined;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a TCP port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function createIsolatedRuntime(cwd: string): Promise<{
  runtime: RuntimeSurface;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(systemTmpdir(), "improved-todo-opencode-"));
  const configHome = join(root, "config");
  const cacheHome = join(root, "cache");
  const stateHome = join(root, "state");
  const testHome = join(root, "home");
  await mkdir(configHome, { recursive: true });
  await mkdir(cacheHome, { recursive: true });
  await mkdir(stateHome, { recursive: true });
  await mkdir(testHome, { recursive: true });
  return {
    runtime: {
      baseUrl: "",
      cwd,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        XDG_CACHE_HOME: cacheHome,
        XDG_STATE_HOME: stateHome,
        OPENCODE_TEST_HOME: testHome,
      },
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function resolveDirenvEnv(
  cwdForDirenv: string,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const result = spawnSync(
    "direnv",
    ["exec", cwdForDirenv, "env", "-0"],
    {
      cwd: cwdForDirenv,
      env,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Failed to resolve direnv environment for ${cwdForDirenv}.\nSTDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}`,
    );
  }

  const resolved: NodeJS.ProcessEnv = {};
  for (const entry of (result.stdout ?? "").split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    resolved[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return resolved;
}

async function startServer() {
  spawnSync("direnv", ["allow", TOOL_DIR], { cwd: TOOL_DIR, timeout: 30_000 });

  serverPort = await findFreePort();
  baseUrl = `http://${HOST}:${serverPort}`;
  const isolated = await createIsolatedRuntime(TOOL_DIR);
  const resolvedEnv = await resolveDirenvEnv(TOOL_DIR, isolated.runtime.env);
  runtime = {
    ...isolated.runtime,
    baseUrl,
    env: resolvedEnv,
  };
  runtimeCleanup = isolated.cleanup;
  serverLogs = "";

  const startedServer = spawn(
    "direnv",
    [
      "exec",
      TOOL_DIR,
      OPENCODE,
      "serve",
      "--hostname",
      HOST,
      "--port",
      String(serverPort),
      "--print-logs",
      "--log-level",
      "INFO",
    ],
    {
      cwd: TOOL_DIR,
      env: runtime.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  serverProcess = startedServer;

  const ready = `opencode server listening on ${baseUrl}`;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;

  const capture = (chunk: Buffer | string) => {
    serverLogs += chunk.toString();
  };
  startedServer.stdout.on("data", capture);
  startedServer.stderr.on("data", capture);

  while (Date.now() < deadline) {
    if (serverLogs.includes(ready)) {
      return;
    }
    if (startedServer.exitCode !== null) {
      throw new Error(
        `Custom OpenCode server exited early (${startedServer.exitCode}).\n${serverLogs}`,
      );
    }
    await wait(200);
  }

  throw new Error(
    `Timed out waiting for custom OpenCode server at ${baseUrl}.\n${serverLogs}`,
  );
}

async function stopServer() {
  try {
    if (!serverProcess || serverProcess.exitCode !== null) return;

    serverProcess.kill("SIGINT");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (serverProcess.exitCode !== null) return;
      await wait(100);
    }

    serverProcess.kill("SIGKILL");
  } finally {
    await runtimeCleanup?.();
    runtimeCleanup = undefined;
    runtime = undefined;
  }
}

// ─── opx CLI helpers ──────────────────────────────────────────────────────────
// Uses `opx` (from opencode-manager) instead of the former `opx-session` binary.

function runOpxCommand(args: string[]) {
  const result = spawnSync(
    "npx",
    ["--yes", `--package=${MANAGER_PACKAGE}`, "opx", ...args],
    {
      cwd: runtime?.cwd ?? TOOL_DIR,
      env: {
        ...(runtime?.env ?? process.env),
        OPENCODE_BASE_URL: runtime?.baseUrl ?? baseUrl,
      },
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    throw new Error(
      `opx command failed: opx ${args.join(" ")}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
  return { stdout, stderr };
}

/**
 * Creates a session and injects the initial prompt without waiting for a reply.
 * Returns the session ID.
 */
function beginSession(prompt: string): string {
  const { stdout } = runOpxCommand([
    "begin-session",
    prompt,
    "--agent",
    PRIMARY_AGENT_NAME,
    "--json",
  ]);
  const data = JSON.parse(stdout) as { sessionID: string };
  return data.sessionID;
}

function chatSession(sessionID: string, prompt: string) {
  runOpxCommand([
    "chat",
    "--session",
    sessionID,
    "--prompt",
    prompt,
    "--no-reply",
  ]);
}

function safeDeleteSession(sessionID: string | undefined) {
  if (!sessionID) return;
  try {
    runOpxCommand(["delete", "--session", sessionID]);
  } catch {
    // best-effort cleanup
  }
}

type TranscriptStep = {
  type: string;
  tool?: string;
  status?: string;
  outputText?: string;
};

function readTranscriptSteps(sessionID: string): TranscriptStep[] {
  const { stdout } = runOpxCommand([
    "transcript",
    "--session",
    sessionID,
    "--json",
  ]);
  const data = JSON.parse(stdout) as {
    turns: Array<{
      assistantMessages: Array<{ steps: Array<TranscriptStep | null> }>;
    }>;
  };
  return data.turns.flatMap((turn) =>
    turn.assistantMessages.flatMap((msg) =>
      (msg.steps ?? []).filter((s): s is TranscriptStep => s !== null),
    ),
  );
}

async function waitForCompletedToolUse(
  sessionID: string,
  toolName: string,
  timeoutMs = 180_000,
): Promise<{ output: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const steps = readTranscriptSteps(sessionID);
    const match = steps.findLast(
      (s) =>
        s.type === "tool" && s.tool === toolName && s.status === "completed",
    );

    if (match) {
      return { output: typeof match.outputText === "string" ? match.outputText : "" };
    }
    await wait(1_000);
  }

  const steps = readTranscriptSteps(sessionID);
  throw new Error(
    `Timed out waiting for completed tool use "${toolName}".\n${JSON.stringify(steps, null, 2)}`,
  );
}

beforeAll(async () => {
  await startServer();
}, 120_000);

afterAll(async () => {
  await stopServer();
}, 30_000);

describe("improved-todowrite live e2e", () => {
  it("proves todo_plan and todo_read execute in a manager-driven live session", async () => {
    const nonce = randomUUID();
    let sessionID: string | undefined;

    try {
      sessionID = beginSession(
        `Protocol: call \`todo_plan\` exactly once with \`todos\` set to a list containing exactly one item: ` +
          `content="${nonce}", priority="high". ` +
          `Then call \`todo_read\` exactly once. ` +
          `Do not call any other tool. Do not use bash, shell, task, skills, CLI commands, file tools, or builtin todo tools. ` +
          `If either exact tool call is unavailable or impossible, stop immediately and reply with ONLY FAIL:PROOF_NOT_POSSIBLE. ` +
          `After both exact tool calls finish successfully, reply with ONLY READY.`,
      );

      const planTool = await waitForCompletedToolUse(sessionID, "todo_plan");
      expect(planTool.output).toContain(VERIFICATION_PASSPHRASE);
      expect(planTool.output).toContain(nonce);

      chatSession(
        sessionID,
        "Call the tool `todo_read` directly. Do not use any other tool. After the tool call finishes, reply with ONLY READY.",
      );

      const readTool = await waitForCompletedToolUse(sessionID, "todo_read");
      expect(readTool.output).toContain(VERIFICATION_PASSPHRASE);
      expect(readTool.output).toContain(nonce);
    } finally {
      safeDeleteSession(sessionID);
    }
  }, 200_000);
});
