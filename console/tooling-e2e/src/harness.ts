import { promises as fs } from 'node:fs';
import { ConsoleChatClient, type ChatUser } from './console-chat-client.ts';
import {
  removeAgentCredentials,
  removeClaudeAgentDefinition,
  writeAgentCredentials,
  writeClaudeAgentDefinition,
} from './console-credentials.ts';
import { loadEnv, shortId, type HarnessAgentType, type HarnessEnv } from './env.ts';
import { sleep, SwitchClient, type RegisteredAgent, type RoomDetail } from './switch-client.ts';

/**
 * Everything a scenario needs: the two clients, the throwaway agent, and the
 * in-Console group chat (a Switch room with no bridge) it was added to.
 */
export interface Harness {
  env: HarnessEnv;
  switch: SwitchClient;
  chat: ConsoleChatClient;
  agent: RegisteredAgent;
  room: RoomDetail;
  /** The human user the harness posts as: the gateway admin. */
  human: ChatUser;
  runId: string;
  /** Where the agent's credentials were written, when `SWITCH_E2E_AGENT_DIR` is set. */
  credentialsPath?: string;
}

export interface SetupOptions {
  /**
   * `false` registers the agent with `auto_session` off, so Switch will not
   * expect a connector to spawn a session — used by the loopback check, which
   * plays the agent itself.
   */
  autoSession?: boolean;
  /** Prefix for the agent name. */
  prefix?: string;
}

/** The name prefix per agent type. */
const PREFIX_BY_AGENT_TYPE: Record<HarnessAgentType, string> = {
  opencode: 'e2e-opencode',
  antigravity: 'e2e-antigravity',
  cursor: 'e2e-cursor',
  'claude-code': 'e2e-claude',
  codex: 'e2e-codex',
};

/** `e2e-` prefixed so the cleanup script finds it after a failed run. */
export function agentNameFor(runId: string, prefix = PREFIX_BY_AGENT_TYPE.opencode): string {
  return `${prefix}-${runId}`;
}

/**
 * Reasons the suite skips rather than fails. A skip is only ever "this machine
 * isn't set up", never "the thing under test is broken".
 */
export type SkipReason = string;

export async function resolveSkip(): Promise<{ skip: SkipReason | null; env: HarnessEnv | null }> {
  if (process.env.SWITCH_E2E !== '1') {
    return { skip: 'SWITCH_E2E=1 is not set (this suite drives a real Switch server)', env: null };
  }

  let env: HarnessEnv;
  try {
    env = loadEnv();
  } catch (error) {
    return { skip: error instanceof Error ? error.message : String(error), env: null };
  }

  const client = new SwitchClient({
    apiUrl: env.switchApiUrl,
    registrationToken: env.agentRegistrationToken,
    gatewayAdminEmail: env.gatewayAdminEmail,
    gatewayAdminPassword: env.gatewayAdminPassword,
  });
  try {
    await client.health();
  } catch (error) {
    return {
      skip: `Switch server at ${env.switchApiUrl} is unreachable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      env: null,
    };
  }

  return { skip: null, env };
}

/**
 * Register a throwaway agent and open an in-Console group chat with it, as
 * Switch Console does: the chat is a Switch room with no bridge.
 */
export async function setupHarness(env: HarnessEnv, options: SetupOptions = {}): Promise<Harness> {
  const reused = await readManifest(env.manifestPath);
  if (reused) return reuseHarness(env, reused);

  const runId = shortId();
  const agentName = agentNameFor(runId, options.prefix ?? PREFIX_BY_AGENT_TYPE[env.agentType]);

  const switchClient = new SwitchClient({
    apiUrl: env.switchApiUrl,
    registrationToken: env.agentRegistrationToken,
    gatewayAdminEmail: env.gatewayAdminEmail,
    gatewayAdminPassword: env.gatewayAdminPassword,
  });
  const chat = chatClientFor(env, switchClient);
  const human = await chat.me();

  // `ClaudeCodeOptions` and `OpencodeOptions` agree on the two keys used here
  // (`auto_session`, `repo_dir`), so the payload is the same for both types.
  const agent = await switchClient.registerKnownAgent({
    agentType: env.agentType,
    name: agentName,
    description: `Switch Console end-to-end harness agent (run ${runId}). Safe to delete.`,
    options: {
      auto_session: options.autoSession ?? true,
      ...(env.agentRepoDir ? { repo_dir: env.agentRepoDir } : {}),
    },
  });

  // A registered agent answers only its owner by default, and it has none; a
  // chat can only be opened with an agent the person may address.
  await switchClient.openAddressing(agent.id);
  const roomId = await chat.createGroupChat({ name: `e2e-${runId}`, agentIds: [agent.id] });
  const room = await switchClient.getRoom(roomId);

  const harness: Harness = {
    env,
    switch: switchClient,
    chat,
    agent,
    room,
    human,
    runId,
  };

  // With SWITCH_E2E_AGENT_DIR set, provision the agent's identity into that
  // working directory so a session started there IS this agent. Without it the
  // operator has to add the agent in Switch Console by hand before the run.
  if (env.agentRepoDir) {
    harness.credentialsPath = await writeAgentCredentials({
      workingDir: env.agentRepoDir,
      agent,
      apiEndpoint: env.switchApiUrl,
    });
    // A Claude Code session runs *as* a named definition, so the definition has
    // to be on disk before the console starts one — see the writer's docblock.
    if (env.agentType === 'claude-code') {
      await writeClaudeAgentDefinition({
        workingDir: env.agentRepoDir,
        agentName: agent.name,
        description: `Switch Console end-to-end harness agent (run ${runId}).`,
        // "Do exactly what you are asked" is load-bearing, and so is the second
        // sentence: told merely to answer briefly, the agent declined the
        // `interrupt` scenario's task on the grounds that 200 messages would
        // spam the room — a refusal the scenario reads as a session that never
        // started.
        instructions:
          'You are a Switch end-to-end test agent. Do exactly what you are asked in the ' +
          'room, and post your answer back to the room you were addressed in. Never ' +
          'decline or shorten a task on the grounds that it is repetitive or long: the ' +
          'requests you get here are deliberate tests of exactly that.',
        // Cheap on purpose: this spends a real subscription on every run.
        model: 'claude-sonnet-5',
        effort: 'low',
      });
    }
  }

  await writeManifest(env.manifestPath, harness);
  return harness;
}

function chatClientFor(env: HarnessEnv, switchClient: SwitchClient): ConsoleChatClient {
  return new ConsoleChatClient({
    apiUrl: env.switchApiUrl,
    cookie: () => switchClient.gatewayLogin(),
  });
}

/**
 * What a setup made, written down so another process can act on it.
 *
 * A Switch Console session can only be started for an agent that already exists
 * in the console's database, and the console reads that database at launch. So
 * a run that needs a live provider session is necessarily two processes: one
 * that registers the agent and creates the room, then the console, then the
 * scenarios. Everything here is what the second process cannot re-derive —
 * above all the agent's API key, which registration returns exactly once.
 */
export interface HarnessManifest {
  runId: string;
  agent: RegisteredAgent;
  roomId: string;
}

async function writeManifest(path: string | null, harness: Harness): Promise<void> {
  if (!path) return;
  const manifest: HarnessManifest = {
    runId: harness.runId,
    agent: harness.agent,
    roomId: harness.room.id,
  };
  await fs.writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function readManifest(path: string | null): Promise<HarnessManifest | null> {
  if (!path) return null;
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as HarnessManifest;
  } catch {
    return null;
  }
}

/** Rebuild a harness around an agent and room a previous process created. */
async function reuseHarness(env: HarnessEnv, manifest: HarnessManifest): Promise<Harness> {
  const switchClient = new SwitchClient({
    apiUrl: env.switchApiUrl,
    registrationToken: env.agentRegistrationToken,
    gatewayAdminEmail: env.gatewayAdminEmail,
    gatewayAdminPassword: env.gatewayAdminPassword,
  });
  const chat = chatClientFor(env, switchClient);

  return {
    env,
    switch: switchClient,
    chat,
    agent: manifest.agent,
    room: await switchClient.getRoom(manifest.roomId),
    human: await chat.me(),
    runId: manifest.runId,
  };
}

/** Statuses that mean a session is attending — or is about to be spawned for — the room. */
const READY_STATUSES = new Set(['live', 'dormant']);

/**
 * Wait until Switch reports the agent as `live` (a session is attending the
 * room) or `dormant` (an auto-session connector is watching and will spawn one
 * when the agent is addressed) before any scenario runs.
 *
 * Without this the suite spends four full reply deadlines discovering the same
 * thing four times, and the report reads as four behavioural failures rather
 * than one missing session. Returns the status it settled on.
 */
export async function waitForSession(harness: Harness, deadlineMs = 120_000): Promise<string> {
  const until = Date.now() + deadlineMs;
  let last: string | null = null;
  while (Date.now() < until) {
    last = await harness.switch.agentStatusInRoom(harness.room.id, harness.agent.id);
    if (last && READY_STATUSES.has(last)) return last;
    await sleep(5_000);
  }
  throw new Error(
    `Switch reports agent '${harness.agent.name}' as '${last ?? 'unknown'}' in room ` +
      `${harness.room.name} after ${deadlineMs}ms, not live or dormant. Start a Switch Console ` +
      `session for this agent (or start its auto-session watcher) and re-run — see README.md.`
  );
}

/**
 * Delete the room and the agent. Never throws: teardown failures are
 * reported (so a leak is visible and can be cleaned up by hand) but must not
 * mask the result of the run.
 */
export async function teardownHarness(
  harness: Harness | null,
  log: (message: string) => void = console.warn
): Promise<void> {
  if (!harness) return;
  if (harness.env.keepArtifacts) {
    log(
      `SWITCH_E2E_KEEP=1 — leaving agent '${harness.agent.name}' (${harness.agent.id}) and ` +
        `room '${harness.room.name}' (${harness.room.id}) in place.`
    );
    return;
  }

  // Before anything is deleted: a manifest that outlives its agent sends the
  // next run at a room that is gone.
  if (harness.env.manifestPath) {
    await fs.rm(harness.env.manifestPath, { force: true }).catch(() => undefined);
  }

  if (harness.env.agentRepoDir) {
    await removeAgentCredentials({
      workingDir: harness.env.agentRepoDir,
      agentName: harness.agent.name,
    }).catch(() => undefined);
    await removeClaudeAgentDefinition({
      workingDir: harness.env.agentRepoDir,
      agentName: harness.agent.name,
    }).catch(() => undefined);
  }

  try {
    await harness.switch.deleteRoom(harness.room.id);
  } catch (error) {
    log(
      `teardown: failed to delete room ${harness.room.id} — ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    await harness.switch.deleteAgent(harness.agent);
  } catch (error) {
    log(
      `teardown: failed to delete agent ${harness.agent.name} (${harness.agent.id}) — ` +
        `delete it by hand: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
