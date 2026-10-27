import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeEnv } from './env.ts';
import {
  resolveSkip,
  setupHarness,
  teardownHarness,
  waitForSession,
  type Harness,
} from './harness.ts';
import { formatResultsTable, SCENARIOS, type ScenarioResult } from './scenarios.ts';

/**
 * The suite. One throwaway agent, one in-Console chat, four scenarios run in
 * order against them, then teardown and a summary table.
 *
 * It **skips** — never fails — when the machine is not set up for it:
 * `SWITCH_E2E=1` unset, configuration missing, or Switch unreachable.
 * The reason is printed, so a skip is never mysterious.
 *
 * It **fails** when the stack is there and the agent does not behave. For a
 * failure to mean anything, a Switch Console session must be running for the
 * registered agent — see README.md, "What must be running".
 */

let harness: Harness | null = null;
let skip: string | null = null;
const results: ScenarioResult[] = [];

beforeAll(async () => {
  const resolved = await resolveSkip();
  skip = resolved.skip;
  if (skip || !resolved.env) return;

  harness = await setupHarness(resolved.env);
  console.log(
    [
      '',
      `Switch Console end-to-end run ${harness.runId}`,
      `  ${describeEnv(resolved.env)}`,
      `  agent    ${harness.agent.name} (${harness.agent.id})`,
      `  room     ${harness.room.name} (${harness.room.id})`,
      '',
      `  A Switch Console session must now be running for '${harness.agent.name}'.`,
      '',
    ].join('\n')
  );

  const status = await waitForSession(
    harness,
    Number(process.env.SWITCH_E2E_SESSION_TIMEOUT_MS ?? 120_000)
  );
  console.log(`  Switch reports the agent as '${status}' in the room — running scenarios.\n`);
}, 600_000);

afterAll(async () => {
  if (results.length > 0) console.log(formatResultsTable(results));
  await teardownHarness(harness);
});

describe('Switch Console provider-backed session, end to end', () => {
  let blockedBy: string | null = null;
  for (const runScenario of SCENARIOS) {
    // The scenario functions are named after the behaviour they exercise, so the
    // test name comes from the function rather than being restated here.
    it(runScenario.name, async (ctx) => {
      if (skip) {
        console.log(`SKIPPED (${runScenario.name}): ${skip}`);
        return;
      }
      if (blockedBy) {
        // A late card from the stuck turn would look like this scenario's own.
        results.push({
          name: runScenario.name,
          ok: false,
          details: `blocked: ${blockedBy} did not stop cleanly`,
          transcript: [],
          durationMs: 0,
        });
        ctx.skip();
      }
      const result = await runScenario(harness!);
      results.push(result);
      if (result.blocksNext) blockedBy = result.name;
      if (!result.ok) {
        console.log(
          `${result.name} transcript:\n` +
            result.transcript
              .map(
                (post) =>
                  `    [${post.sender.agentId === harness!.agent.id ? 'agent' : 'user '}] ${post.body}`
              )
              .join('\n')
        );
      }
      expect(result.ok, result.details).toBe(true);
    });
  }
});
