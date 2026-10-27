import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage, ChatRequest } from './console-chat-client.ts';
import type { Harness } from './harness.ts';
import { sleep } from './switch-client.ts';

/**
 * The scenarios. Each one drives the full path
 *
 *     in-Console chat -> Switch room -> Switch Console session -> agent -> room
 *
 * by posting as a human through the Console's own chat routes and waiting on
 * what the agent posts back. Nothing
 * here talks to Switch Console directly: if a scenario passes, a real operator
 * doing the same thing by hand would have seen the same result.
 *
 * A scenario **never throws past its own boundary** — a failure is a
 * `{ ok: false }` result carrying the transcript it did see, so one broken
 * behaviour does not hide the other three.
 */

export interface ScenarioResult {
  name: string;
  ok: boolean;
  details: string;
  transcript: ChatMessage[];
  durationMs: number;
  /** Stop or settling failed after this scenario, so the agent may still be busy. */
  blocksNext?: boolean;
}

export type Scenario = (harness: Harness) => Promise<ScenarioResult>;

/** How long a scenario waits for the agent to say something. */
const REPLY_DEADLINE_MS = Number(process.env.SWITCH_E2E_REPLY_TIMEOUT_MS ?? 5 * 60_000);

/**
 * Phrases Switch itself posts **as the agent** when there is no live
 * session — the onboarding notice, and the command handlers' refusals.
 *
 * They have to be recognised rather than treated as agent output, because they
 * are indistinguishable from it by author: verified against a live server, the
 * "I'm not online in this room" notice arrives from the agent's own account, not
 * from the Switch Admin. A scenario that accepts any agent message therefore
 * passes with no session running at all — which is exactly the silent-green
 * failure this harness exists to rule out.
 */
const NO_SESSION_MARKERS = [
  "i'm not online in this room",
  "i don't have a session connected to this room",
  "isn't reporting as live",
  'no active session in this room',
  "i can't be interrupted",
  'this isn’t supported for me',
  "my session wasn't started from switch console",
  'open switch console to bring me online',
];

/** Whether a post is one of Switch's own no-session notices rather than agent output. */
export function isNoSessionNotice(post: ChatMessage): boolean {
  const text = post.body.toLowerCase();
  return NO_SESSION_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Switch's own running commentary, posted **as the agent** while a session
 * works: the activity ticker, the "needs your input" ping, the acknowledgement
 * of a control command.
 *
 * They have to be told apart from agent output for the same reason as the
 * no-session notices — the author is identical. A runtime status message is not evidence that an agent performed a task.
 */
const RUNTIME_STATUS_MARKERS = [
  '_working on it…_',
  '✓ done ·',
  '✓ input received',
  'needs your input.',
  'starting a session to handle this',
  'interrupted my current turn',
];

/** Whether a post is Switch narrating the session rather than the agent speaking. */
export function isRuntimeStatusPost(post: ChatMessage): boolean {
  const text = post.body.toLowerCase();
  return RUNTIME_STATUS_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Turn a no-session notice into the failure it is. Every scenario funnels its
 * "the agent said nothing useful" path through here so the report names the
 * cause — no session — instead of a bare timeout.
 */
function assertNotNoSession(posts: ChatMessage[]): void {
  const notice = posts.find(isNoSessionNotice);
  if (notice) {
    throw new Error(
      `No live Switch Console session for this agent — Switch answered on its behalf: ` +
        `«${notice.body.replace(/\s+/g, ' ').slice(0, 200)}»`
    );
  }
}

/** The marker the agent is asked to echo — distinctive enough to grep a room for. */
export const OK_MARKER = 'SWITCH_E2E_OK';

/**
 * Wrap a scenario body so it always resolves to a result. An exception becomes
 * `ok: false` with the message as `details`; the transcript collected so far is
 * whatever the body managed to record.
 */
async function scenario(
  harness: Harness,
  name: string,
  body: (record: (posts: ChatMessage[]) => void, known: Set<string>) => Promise<string>
): Promise<ScenarioResult> {
  const started = Date.now();
  // Request ids already in the room, so this scenario only ever answers its own cards.
  let known = new Set<string>();
  let transcript: ChatMessage[] = [];
  const record = (posts: ChatMessage[]): void => {
    const seen = new Set(transcript.map((post) => post.messageId));
    transcript = [...transcript, ...posts.filter((post) => !seen.has(post.messageId))].sort(
      (a, b) => a.seq - b.seq
    );
  };

  try {
    known = new Set((await harness.chat.requests(harness.room.id)).map((r) => r.requestId));
    const details = await body(record, known);
    return { name, ok: true, details, transcript, durationMs: Date.now() - started };
  } catch (error) {
    let details = error instanceof Error ? error.message : String(error);
    let blocksNext = false;
    // Stop the turn so an unanswered card or a stuck command cannot block the next scenario.
    await harness.chat
      .control(harness.room.id, harness.agent.id, 'interrupt')
      .then(() => settle(harness, known))
      .catch((stopError: unknown) => {
        blocksNext = true;
        details += ` (and Stop failed: ${stopError instanceof Error ? stopError.message : String(stopError)})`;
      });
    return {
      name,
      ok: false,
      details,
      transcript,
      durationMs: Date.now() - started,
      blocksNext,
    };
  }
}

const SETTLE_DEADLINE_MS = 60_000;

/**
 * Stop only confirms the command was accepted. Wait until the agent has no
 * queued/running turn and none of this scenario's requests is still open.
 */
async function settle(harness: Harness, known: Set<string>): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  for (;;) {
    const { items, approvals } = await harness.chat.activity(harness.room.id);
    const running = items.filter(
      (item) =>
        item.agentId === harness.agent.id &&
        item.kind === 'turn' &&
        (item.status === 'queued' || item.status === 'running')
    );
    const open = approvals.filter(
      (request) =>
        request.agentId === harness.agent.id &&
        request.state === 'open' &&
        !known.has(request.requestId)
    );
    if (running.length === 0 && open.length === 0) return;
    if (Date.now() >= deadline)
      throw new Error(
        `agent did not settle ${SETTLE_DEADLINE_MS / 1000}s after Stop: ` +
          `running turns [${running.map((item) => item.turnId).join(', ')}], ` +
          `open requests [${open.map((request) => request.requestId).join(', ')}]`
      );
    await sleep(2_000);
  }
}

/** Post `@agent <text>` and return its position in the room. */
async function ask(harness: Harness, text: string): Promise<number> {
  const sent = await harness.chat.send(harness.room.id, `@${harness.agent.name} ${text}`);
  return sent.seq;
}

/** Wait for an agent message matching `predicate`, or throw with the transcript. */
async function expectBotPost(
  harness: Harness,
  params: {
    since: number;
    predicate: (post: ChatMessage) => boolean;
    describe: string;
    deadlineMs?: number;
    record: (posts: ChatMessage[]) => void;
  }
): Promise<ChatMessage> {
  const { match, transcript } = await harness.chat.waitForMessage({
    roomId: harness.room.id,
    fromAgentId: harness.agent.id,
    // Neither a no-session notice nor Switch's activity commentary is ever a
    // match, however permissive the caller's predicate — both are Switch
    // talking on the agent's account, not the agent.
    predicate: (post) =>
      !isNoSessionNotice(post) && !isRuntimeStatusPost(post) && params.predicate(post),
    afterSeq: params.since,
    deadlineMs: params.deadlineMs ?? REPLY_DEADLINE_MS,
  });
  params.record(transcript);
  if (!match) {
    assertNotNoSession(transcript);
    throw new Error(
      `Timed out waiting for ${params.describe}. Room said: ${summarise(transcript)}`
    );
  }
  return match;
}

/**
 * Wait for the agent's open question or permission request in the room — the
 * card Console draws in place of room text — or throw with the transcript.
 */
async function expectRequest(
  harness: Harness,
  params: {
    since: number;
    kind: ChatRequest['kind'];
    known: Set<string>;
    describe: string;
    record: (posts: ChatMessage[]) => void;
  }
): Promise<ChatRequest> {
  const request = await harness.chat.waitForOpenRequest({
    roomId: harness.room.id,
    agentId: harness.agent.id,
    kind: params.kind,
    known: params.known,
    deadlineMs: REPLY_DEADLINE_MS,
  });
  if (request) return request;
  const transcript = await harness.chat.messagesAfter(harness.room.id, params.since);
  params.record(transcript);
  assertNotNoSession(transcript);
  throw new Error(`Timed out waiting for ${params.describe}. Room said: ${summarise(transcript)}`);
}

/** Answer a permission card with its plain allow, after checking it is for `mention`. */
async function allowRequest(
  harness: Harness,
  request: ChatRequest,
  mention: string
): Promise<void> {
  const shown = `${request.title}\n${request.detail ?? ''}`;
  if (!shown.includes(mention))
    throw new Error(`The permission request does not name ${mention}: «${shown}»`);
  const allow = request.options.find((option) => option.decision === 'accept');
  if (!allow)
    throw new Error(
      `The permission request offers no allow option: ${JSON.stringify(request.options)}`
    );
  await harness.chat.answer(request, { answer: allow.id });
}

function summarise(posts: ChatMessage[]): string {
  if (posts.length === 0) return '(nothing at all — no session ever replied)';
  return posts.map((post) => `«${post.body.replace(/\s+/g, ' ').slice(0, 160)}»`).join(' | ');
}

function lower(post: ChatMessage): string {
  return post.body.toLowerCase();
}

// ── greet ────────────────────────────────────────────────────────────────────

/**
 * The smoke test: does an addressed message reach a session at all, and does its
 * answer come back into the room as the agent?
 *
 * Everything else assumes this passes. A failure here means either no session is
 * running for the agent, or nothing is relaying the room's events into it.
 */
export const greet: Scenario = (harness) =>
  scenario(harness, 'greet', async (record) => {
    const since = await ask(harness, `reply with exactly ${OK_MARKER} and nothing else`);
    const match = await expectBotPost(harness, {
      since,
      record,
      predicate: (post) => post.body.includes(OK_MARKER),
      describe: `a reply containing ${OK_MARKER}`,
    });
    return `agent replied in message ${match.messageId}`;
  });

// ── question ─────────────────────────────────────────────────────────────────

const CHOICES = ['red', 'green', 'blue'] as const;
const CHOSEN = 'green';

/**
 * A two-turn exchange: the agent asks a clarifying question, the human answers
 * it (the card, or in the room for a prose question), and the agent uses the answer.
 *
 * This is the round trip a one-shot reply cannot fake — it only passes if the
 * session is still alive and still connected to the room when the second message
 * arrives, which is the thing an injected-prompt runtime most easily gets wrong.
 */
export const question: Scenario = (harness) =>
  scenario(harness, 'question', async (record, known) => {
    const prose = harness.env.questionMode === 'prose';
    const since = await ask(
      harness,
      prose
        ? 'before answering, ask me one clarifying multiple-choice question as an ordinary ' +
            `message: "Which color?", listing exactly the options ${CHOICES.join(', ')}. ` +
            'Wait for my answer, then reply with the single word I chose.'
        : 'before answering, ask me one clarifying multiple-choice question using your ' +
            'ask-the-user tool (the question tool, not a plain message): "Which color?" with ' +
            `exactly the options ${CHOICES.join(', ')}. Then reply with the single word I chose.`
    );

    let asked: string;
    let answeredAt = since;
    if (prose) {
      asked = (
        await expectBotPost(harness, {
          since,
          record,
          predicate: (post) => CHOICES.every((choice) => lower(post).includes(choice)),
          describe: `a question listing the options ${CHOICES.join('/')}`,
        })
      ).messageId;
      answeredAt = await ask(harness, CHOSEN);
    } else {
      // A native question is not posted into the room: Console draws it as a
      // card and answers it through Switch, as the harness does here.
      const request = await expectRequest(harness, {
        since,
        kind: 'questions',
        known,
        describe: `a question card offering ${CHOICES.join('/')}`,
        record,
      });
      const color = request.questions.find(
        (q) =>
          `${q.title} ${q.prompt}`.toLowerCase().includes('color') &&
          CHOICES.every((choice) => q.options.some((o) => o.label.toLowerCase() === choice))
      );
      if (!color)
        throw new Error(
          `The question card is not "Which color?" with ${CHOICES.join('/')}: ${JSON.stringify(request.questions)}`
        );
      const chosen = color.options.find((o) => o.label.toLowerCase() === CHOSEN)!;
      await harness.chat.answer(request, {
        answers: [{ questionId: color.id, selectedOptionIds: [chosen.id], customText: null }],
      });
      asked = `card ${request.requestId}`;
    }

    // The agent's own reply, told apart from any acknowledgement naming the choice.
    const answer = await expectBotPost(harness, {
      since: answeredAt,
      record,
      predicate: (post) => lower(post).includes(CHOSEN) && !post.body.trimStart().startsWith('✅'),
      describe: `a reply naming my choice '${CHOSEN}'`,
    });

    return `asked in ${asked}, answered in ${answer.messageId}`;
  });

// ── approval ─────────────────────────────────────────────────────────────────

/**
 * A tool call the agent is not pre-authorised to make: the session must surface
 * the permission request as a card in the room, take its allow from the
 * person, and then actually run the command.
 *
 * Requires the agent's session to be running WITHOUT auto-approve. Note that an
 * OpenCode agent's registered profile declares no `pre_invocation_mediation`, so
 * the prompt does not come from Switch mediating the call — it comes from the
 * console runtime relaying OpenCode's own permission request into the room. This
 * is the scenario most tightly coupled to that runtime.
 */
export const approval: Scenario = (harness) =>
  scenario(harness, 'approval', async (record, known) => {
    const file = `approved-${harness.runId}.txt`;
    const since = await ask(
      harness,
      `run the shell command \`echo ${OK_MARKER} > ${file}\` and then reply with the single word done`
    );

    const prompt = await expectRequest(harness, {
      since,
      kind: 'approval',
      known,
      describe: 'a permission card for the shell command',
      record,
    });
    await allowRequest(harness, prompt, file);

    const done = await expectBotPost(harness, {
      since,
      record,
      predicate: (post) => lower(post).includes('done'),
      describe: "a 'done' reply after the command was approved",
    });

    // Without SWITCH_E2E_AGENT_DIR the agent's working directory is unknown here, so the file cannot be checked.
    const dir = harness.env.agentRepoDir;
    if (!dir)
      return `prompted in card ${prompt.requestId}, completed in ${done.messageId} (file not checked: no SWITCH_E2E_AGENT_DIR)`;
    const written = await markerContents(path.join(dir, file));
    if (written?.trim() !== OK_MARKER)
      throw new Error(
        `The approved command did not write ${OK_MARKER} to ${file}: ${JSON.stringify(written)}`
      );
    return `prompted in card ${prompt.requestId}, completed in ${done.messageId}, ${file} written`;
  });

// ── interrupt ────────────────────────────────────────────────────────────────

/** Only the command's exact marker proves execution began. */
export function isStartMarker(text: string): boolean {
  return text === 'SWITCH_INTERRUPT_STARTED';
}

async function markerContents(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** A real local command must start and then be cancelled before its final write. */
export const interrupt: Scenario = (harness) =>
  scenario(harness, 'interrupt', async (record, known) => {
    const dir = harness.env.agentRepoDir;
    if (!dir)
      throw new Error('The interrupt scenario requires SWITCH_E2E_AGENT_DIR on this machine.');
    const stem = `interrupt-${harness.runId}-${Date.now()}`;
    const startedFile = path.join(dir, `${stem}-started.txt`);
    const finishedFile = path.join(dir, `${stem}-finished.txt`);
    const command = `printf SWITCH_INTERRUPT_STARTED > ${stem}-started.txt; sleep 90; printf SWITCH_INTERRUPT_FINISHED > ${stem}-finished.txt`;
    const since = await ask(
      harness,
      `Run this exact shell command for a bounded cancellation test: \`${command}\`. Wait for completion before replying. Do not create these files with another tool.`
    );
    const prompt = await expectRequest(harness, {
      since,
      kind: 'approval',
      known,
      describe: 'permission to run the cancellation command',
      record,
    });
    await allowRequest(harness, prompt, stem);
    const deadline = Date.now() + 60_000;
    while (!isStartMarker((await markerContents(startedFile)) ?? '')) {
      if (Date.now() > deadline)
        throw new Error('The cancellation command did not write its start marker.');
      await sleep(500);
    }
    const startedAt = Date.now();
    // The Console's Stop: `!interrupt @agent`, posted into the room.
    await harness.chat.control(harness.room.id, harness.agent.id, 'interrupt');
    // Wait beyond the command's complete lifetime; an un-cancelled sleep must finish.
    while (Date.now() - startedAt < 95_000) {
      if ((await markerContents(finishedFile)) !== null)
        throw new Error('The interrupted command wrote its completion marker.');
      await sleep(1_000);
    }
    const posts = await harness.chat.messagesAfter(harness.room.id, since);
    record(posts);
    assertNotNoSession(posts);
    if ((await markerContents(finishedFile)) !== null)
      throw new Error('The interrupted command completed.');
    await settle(harness, known);
    return 'command start confirmed; completion marker absent after 95s';
  });

export const SCENARIOS: Scenario[] = [greet, question, approval, interrupt];

/** Fixed-width summary of a run, printed at the end of the suite. */
export function formatResultsTable(results: ScenarioResult[]): string {
  const nameWidth = Math.max(8, ...results.map((result) => result.name.length));
  const rows = results.map((result) => {
    const status = result.ok ? 'PASS' : 'FAIL';
    const seconds = `${(result.durationMs / 1000).toFixed(1)}s`.padStart(7);
    return `  ${result.name.padEnd(nameWidth)}  ${status}  ${seconds}  ${result.details}`;
  });
  const passed = results.filter((result) => result.ok).length;
  return [
    '',
    `Scenario results (${passed}/${results.length} passed)`,
    `  ${'scenario'.padEnd(nameWidth)}  ────  ─────── details`,
    ...rows,
    '',
  ].join('\n');
}
