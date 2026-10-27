import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeEnv } from './env.ts';
import { resolveSkip, setupHarness, teardownHarness, type Harness } from './harness.ts';
import { eventText } from './switch-client.ts';

/**
 * Renaming an agent, end to end against a live Switch, with no Switch Console
 * and no model in the loop (the harness plays the agent, as the loopback check
 * does): a rename from the gateway takes effect in the in-Console chat, so the
 * new name reaches the agent and the old one does not.
 *
 * `!rename-agent` and `!delete-agent` are typed chat commands, which an
 * in-Console chat has no way to send; their handlers are covered by the core
 * command tests.
 */

let harness: Harness | null = null;
let skip: string | null = null;

beforeAll(async () => {
  const resolved = await resolveSkip();
  skip = resolved.skip;
  if (skip || !resolved.env) return;
  harness = await setupHarness(resolved.env, { autoSession: false, prefix: 'e2e-rn' });
  console.log(
    `identity: ${describeEnv(resolved.env)} agent=${harness.agent.name} (${harness.agent.id}) ` +
      `room=${harness.room.id}`
  );
}, 300_000);

afterAll(async () => {
  await teardownHarness(harness);
});

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

describe('renaming an agent', () => {
  it('a gateway rename renames the agent, and routing follows', async () => {
    if (skip) return void console.log(`SKIPPED: ${skip}`);
    const h = harness!;
    const oldName = h.agent.name;
    // Still `e2e-` prefixed so the cleanup script finds it after a failed run.
    const newName = oldName.replace(/^e2e-rn/, 'e2e-ra');

    const result = await h.switch.renameAgent(h.agent.id, newName, 'Rename Check');

    expect(result.name).toBe(newName);
    expect(result.bridgeFailures).toEqual([]);
    expect(await reachesAgent(newName)).toBe(true);
    expect(await reachesAgent(oldName)).toBe(false);
  }, 300_000);
});
