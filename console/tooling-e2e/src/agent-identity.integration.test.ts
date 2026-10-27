import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeEnv } from './env.ts';
import { resolveSkip, setupHarness, teardownHarness, type Harness } from './harness.ts';
import { eventText, sleep } from './switch-client.ts';

/**
 * Renaming and deleting an agent, end to end against a live Switch, with no
 * Switch Console and no model in the loop (the harness plays the agent, as the
 * loopback check does), through the in-Console chat:
 *
 * 1. a rename from the gateway takes effect, so the new name reaches the agent
 *    and the old one does not;
 * 2. `!rename-agent` typed in the chat does the same, for the person who owns
 *    the agent or administers the workspace;
 * 3. `!delete-agent`, confirmed, deletes it.
 *
 * The scenarios run in order and each builds on the last.
 */

let harness: Harness | null = null;
let skip: string | null = null;
let currentName = '';

beforeAll(async () => {
  const resolved = await resolveSkip();
  skip = resolved.skip;
  if (skip || !resolved.env) return;
  harness = await setupHarness(resolved.env, { autoSession: false, prefix: 'e2e-rn' });
  currentName = harness.agent.name;
  console.log(
    `identity: ${describeEnv(resolved.env)} agent=${harness.agent.name} (${harness.agent.id}) ` +
      `room=${harness.room.id}`
  );
}, 300_000);

afterAll(async () => {
  await teardownHarness(harness);
});

function renamed(suffix: string): string {
  // Still `e2e-` prefixed so the cleanup script finds it after a failed run.
  return harness!.agent.name.replace(/^e2e-rn/, `e2e-r${suffix}`);
}

/** Type `command` into the chat and wait for Switch's reply matching `pattern`. */
async function command(text: string, pattern: RegExp): Promise<void> {
  const h = harness!;
  const sent = await h.chat.send(h.room.id, text);
  const until = Date.now() + 60_000;
  for (;;) {
    const transcript = await h.chat.messagesAfter(h.room.id, sent.seq);
    if (transcript.some((message) => pattern.test(message.body))) return;
    if (Date.now() >= until) {
      throw new Error(
        `Switch never replied to ${text} with ${pattern}. Transcript: ` +
          transcript.map((m) => `${m.sender.name}: ${m.body}`).join(' | ')
      );
    }
    await sleep(1_000);
  }
}

async function reachesAgent(name: string): Promise<boolean> {
  const h = harness!;
  const marker = `SWITCH_E2E_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  await h.chat.send(h.room.id, `@${name} ping ${marker}`);
  const seen = await h.switch.waitForNotification(
    h.agent,
    (event) => eventText(event).includes(marker),
    20_000
  );
  return seen.match !== null;
}

describe('renaming and deleting an agent', () => {
  it('a gateway rename renames the agent, and routing follows', async () => {
    if (skip) return void console.log(`SKIPPED: ${skip}`);
    const h = harness!;
    const newName = renamed('a');

    const result = await h.switch.renameAgent(h.agent.id, newName, 'Rename Check');

    expect(result.name).toBe(newName);
    expect(result.bridgeFailures).toEqual([]);
    expect(await reachesAgent(newName)).toBe(true);
    expect(await reachesAgent(currentName)).toBe(false);
    currentName = newName;
  }, 300_000);

  it('!rename-agent from the chat renames it for the owner or admin', async () => {
    if (skip) return void console.log(`SKIPPED: ${skip}`);
    const newName = renamed('b');

    await command(`!rename-agent @${currentName} ${newName}`, /Renamed/);

    expect(await reachesAgent(newName)).toBe(true);
    currentName = newName;
  }, 300_000);

  it('!delete-agent asks first, and deletes once confirmed', async () => {
    if (skip) return void console.log(`SKIPPED: ${skip}`);
    const h = harness!;

    await command(`!delete-agent @${currentName}`, /To go ahead/);
    expect((await h.switch.listAgents()).some((a) => a.id === h.agent.id)).toBe(true);

    await command(`!delete-agent ${currentName} confirm`, /Deleted/);
    // The delete reaches the agent list once it has committed.
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!(await h.switch.listAgents()).some((a) => a.id === h.agent.id)) break;
      await sleep(1_000);
    }
    expect((await h.switch.listAgents()).some((a) => a.id === h.agent.id)).toBe(false);
  }, 300_000);
});
