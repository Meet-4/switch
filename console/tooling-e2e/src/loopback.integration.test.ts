import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeEnv } from './env.ts';
import { resolveSkip, setupHarness, teardownHarness, type Harness } from './harness.ts';
import { eventText } from './switch-client.ts';

/**
 * The harness's own plumbing, proved against a live stack with **no Switch
 * Console and no model in the loop**: the harness plays both parts.
 *
 * 1. register an agent, open an in-Console group chat with it, and confirm the
 *    room has the agent and no bridge;
 * 2. post `@agent …` as a human through the chat and confirm the addressed
 *    message reaches the agent-facing notification stream;
 * 3. `POST /agents/{id}/message` as the agent and confirm it lands back in the
 *    chat as the agent.
 *
 * If this file passes and `run.integration.test.ts` fails, the fault is in the
 * console session, not in Switch or the harness.
 */

let harness: Harness | null = null;
let skip: string | null = null;

beforeAll(async () => {
  const resolved = await resolveSkip();
  skip = resolved.skip;
  if (skip || !resolved.env) return;
  // auto_session off: nothing is expected to spawn a session — this test *is*
  // the agent, so an auto_session profile would only invite the operator's
  // console to fight it for the room.
  harness = await setupHarness(resolved.env, { autoSession: false, prefix: 'e2e-loop' });
  console.log(
    `loopback: ${describeEnv(resolved.env)} agent=${harness.agent.name} (${harness.agent.id}) ` +
      `room=${harness.room.name} (${harness.room.id})`
  );
}, 300_000);

afterAll(async () => {
  await teardownHarness(harness);
});

describe('Switch <-> in-Console chat loopback', () => {
  it('opens a Switch room with the agent and no bridge for an in-Console chat', () => {
    if (skip) return void console.log(`SKIPPED: ${skip}`);
    expect(harness).not.toBeNull();
    expect(harness!.room.bridgeId).toBeNull();
    expect(harness!.room.agentIds).toContain(harness!.agent.id);
  });

  it('delivers an addressed chat message to the agent, and the agent reply back to the chat', async () => {
    if (skip) return void console.log(`SKIPPED: ${skip}`);
    const h = harness!;
    const marker = `SWITCH_E2E_${h.runId.toUpperCase()}`;

    const posted = await h.chat.send(h.room.id, `@${h.agent.name} hello ${marker}`);
    console.log(`loopback: posted ${posted.messageId} as ${h.human.name}`);

    // ── inbound: room -> Switch -> agent ────────────────────────────────────
    const inbound = await h.switch.waitForNotification(
      h.agent,
      (event) => eventText(event).includes(marker),
      120_000
    );
    if (!inbound.match) {
      throw new Error(
        `Addressed message never reached the agent's notification stream. Saw: ${JSON.stringify(
          inbound.seen
        ).slice(0, 1000)}`
      );
    }
    expect(inbound.match.room_id).toBe(h.room.id);
    console.log(
      `loopback: agent received event type=${inbound.match.type} room=${inbound.match.room_id}`
    );

    // ── outbound: agent -> Switch -> room ───────────────────────────────────
    const reply = `ack ${marker}`;
    const eventId = await h.switch.sendMessage(h.agent, h.room.id, reply);
    expect(eventId).toBeTruthy();

    const outbound = await h.chat.waitForMessage({
      roomId: h.room.id,
      fromAgentId: h.agent.id,
      predicate: (message) => message.body.includes(marker),
      afterSeq: posted.seq,
      deadlineMs: 120_000,
    });
    if (!outbound.match) {
      throw new Error(
        `Agent reply never appeared in the chat as ${h.agent.name}. Transcript: ` +
          outbound.transcript.map((m) => `${m.sender.name}: ${m.body}`).join(' | ')
      );
    }
    console.log(
      `loopback: chat message ${outbound.match.messageId} (event ${eventId}) — round trip closed`
    );
  }, 400_000);
});
