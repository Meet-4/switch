# decision-routing-setup: user-perspective verification

Walked on 2026-10-27 against a local stack built from `feat/decision-routing`
at `9da9f9751` (switch repo, `~/dev/switch-routing`). Status: complete.

| Journey / task | Result |
|---|---|
| 1 No backend | PASS |
| 2 Server default (Qwen) | PASS (Mattermost and Slack) |
| 3 Two workspaces, Haiku in A | PASS |
| 4 Service down, notice, triage fallback | PASS (Mattermost and Slack) |
| 5 Restart mid-decision, expiry | PASS |
| 6 Room toggle matches `!auto-route` | PASS (gateway and Console) |
| 2.6 settings API as two admins | PASS |
| 3.3 Console Decision routing | PASS, three UI notes |
| 6.2 telemetry | PASS |
| 7.3 chart and compose | PARTLY: `helm template` only, no kind; compose profile not re-run |

## Stack

| Piece | How it ran |
|---|---|
| switch-core | the branch, `uv run --project core python -m switch_core.main` on :8000, env from the worktree `.env` plus `FEATURE_FLAGS_ENABLED=follow_the_conversation,decision_routing,agent_management`, `TELEMETRY_ENABLED=true TELEMETRY_ENDPOINT=http://127.0.0.1:4319` (a local sink), `DECISION_TIMEOUT_SECONDS=30` |
| Database | the shared `switch-slackqa-postgres-1` (127.0.0.1:5432). The branch migrations ran on first start (`c7715ebb95c9 -> f68b679599ab -> 689d7d8ff913`). A dump taken before is at `/tmp/drv/slackqa-switch-before-branch.dump`. |
| Decision service | the branch's `decision/` package on :8250, `DECISION_BACKEND=llamacpp LLAMACPP_URL=http://127.0.0.1:8300` (Qwen3.5-4B Q4_K_M under llama.cpp on the Mac's GPU, owned by another session) |
| Mattermost | `mattermost/mattermost-team-edition:latest` (12.0.0, amd64 under emulation in colima) with its own Postgres, compose project `switch-drv` (`/tmp/drv/mm-compose.yml`), because the repo compose's Postgres would take :5432 |
| Workspaces | **A** = `Default` (also holds the owner's Slack bridge), admin `alice@example.test`; **B** = `Workspace B`, admin `beth@example.test`. Each has its own Mattermost bridge (teams `switch` and `switch-b`). The operator (`admin@switch.local`) created both users and B. |
| Agents | scripted agents (`/tmp/drv/walk.py agents`), not Claude: they open the agent event stream with `filter=all`, record every event with Switch's `addressed`, `routed` and `routed_reason` fields, and reply "got it (<reason>)" when addressed. A: `mm-deploy-bot`, `mm-billing-bot`, `mm-docs-bot`, `mm-triage-bot`; B: `b-deploy-bot`, `b-billing-bot`, `b-docs-bot`. the owner's real controller agents (`deploy-bot`, `billing-bot`, `docs-bot`) were left alone. |
| People | messages are posted in Mattermost as the seeded person `user` through the Mattermost API (a real person's post, not an app post). |
| Gateway web app | the branch's `gateway/` under Vite on :5173, screenshots with headless Playwright Chromium |

## Journey 1: no backend — PASS

Steps: started switch-core with no `DECISION_ENDPOINT_URL` (startup warns: "there is no server default, so auto-route is unavailable in every workspace whose admins have not chosen a decision service"). Workspace A had no setting.

- `!auto-route on` in `ar-a1` (Mattermost): Switch replied in thread "Auto-route needs a decision service. A workspace admin can set one up in Switch Console → Admin → Decision routing. Nothing was changed." Evidence: `j1-mattermost-auto-route-on-refused.png`.
- `GET /gateway/rooms/{ar-a1}`: `auto_route = {on: false, available: false, reason: "Auto-route needs a decision service. …"}`. `PUT /rooms/{id}/auto-route {"on": true}` → 409 with the same reason.
- `GET /gateway/decision-settings` (alice): `source: server_default`, `effective.backend: none`, `server_default.configured: false`, `options.haiku_anthropic: false`.
- Gateway room page shows the Auto-route section with the reason and the toggle off. Evidence: `j1-gateway-room-unavailable.png`.
- Untagged "how do I roll back the deploy…" reached no agent as addressed (all four saw it unaddressed), and no notice was posted — today's behaviour.
- A Slack room that already had `auto_route_on` (`auto-route-demo`) reads `on: true, available: false` with the same reason.

## Journey 2: server default (branch decision service, real Qwen) — PASS

Restarted switch-core with `DECISION_ENDPOINT_URL=http://127.0.0.1:8250`.

- `GET /decision-settings` (alice): `source: server_default`, `effective: {backend: endpoint, endpoint: http://127.0.0.1:8250, available: true}`, `options.haiku_anthropic: true`, `haiku_bedrock: false`.
- `POST /decision-settings/test {"backend":"default"}`: `{"ok":true,"agent":"deploy-bot","confidence":0.999,"latency_ms":1971,"backend":"default"}` (the first call after start; later decisions 0.7–1.3 s on the Mac).
- `!auto-route on` in `ar-a1`: "Automatic routing is **on** in this room…".
- Untagged "the production deploy failed halfway through the rollout, can someone roll it back?" → only `mm-deploy-bot` received it as addressed (`routed=True routed_reason=decided`), replied 2.6 s after the post. Log: `Decision routing: … candidates=4 choice=mm-deploy-bot confidence=0.992 threshold=0.6 latency_ms=1258 model=qwen3.5-4b-q4_k_m backend=server_default`, then `outcome=delivered`. The decision service's own log line carries no message text: `decide backend=llamacpp model=qwen3.5-4b-q4_k_m candidates=4 choice=mm-deploy-bot confidence=0.99 threshold=0.60 picked=mm-deploy-bot latency_ms=1249`.
- Untagged "why was I charged twice on this month invoice?" → only `mm-billing-bot`.
- "thanks all, have a good weekend" → nobody.
- Evidence: `j2-mattermost-deploy-question-routed.png`, `j2-gateway-room-on-available.png`.

## Journey 3: two workspaces, Haiku in A — PASS

All through the API as each workspace's admin (task 2.6); transcript in `j3-curl.log` (the key never appears in it).

- alice Test with the entered, unsaved Anthropic key: `{"ok":true,"agent":"deploy-bot","confidence":0.95,"latency_ms":1834,"backend":"haiku_anthropic"}`.
- alice PUT `haiku_anthropic` + key: response `source: workspace`, `has_api_key: true`, `api_key_last4: "cwAA"` — the key itself is never returned.
- alice Test with the stored key (key omitted): ok, 1206 ms.
- beth GET in B: `source: server_default`, `workspace: null` — nothing of A's.
- No restart. Untagged "our staging deploy pipeline is stuck on the migrate step…" in A → only `mm-deploy-bot`; log `model=claude-haiku-5-5 backend=haiku_anthropic latency_ms=4110`. Same text in B's `ar-b1` → only `b-deploy-bot`; log `model=qwen3.5-4b-q4_k_m backend=server_default latency_ms=717`.
- Isolation: beth switched her session into Default (where new users land as members): GET/PUT/DELETE `/decision-settings` → 403 "Tenant admin access required". alice switching into B → 403 "Not a member of this tenant". beth's Test of `haiku_anthropic` with no key in B → `not_configured` ("needs an Anthropic key"), i.e. A's stored key is not borrowed.
- beth PUT `none` in B: `effective.available: false`, reason "This workspace's admins turned auto-route off by choosing no decision service…". `ar-b1` room detail now `available: false` with that reason, `ar-a1` stays `available: true` (Haiku). An untagged deploy question in B reached nobody and posted no notice; the next untagged question in A still went to `mm-deploy-bot` via Haiku (2941 ms). `!auto-route` in B: "Automatic routing is **on** … It can't act right now: This workspace's admins turned auto-route off…". Evidence: `j3-gateway-roomB-unavailable-after-none.png`, `j3-mattermost-B.png`.
- alice DELETE → 204; A back on `source: server_default`.

## Journey 4: service down — PASS

- Stopped the decision service on :8250 (A on the server default). Untagged "the deploy to production is failing on the health check…" → no agent; one notice in the room from Switch's admin client: "Auto-route is unavailable right now; tag an agent to reach it." Log: `outcome=nobody reason=the decision service failed (unreachable) and the room has no triage agent`. Room metadata gained `decision_notice_at`.
- Second untagged question a few seconds later → no agent, **no second notice**.
- `@mm-deploy-bot …` → delivered as a mention (`routed=False`), answered in 1.1 s. (The next untagged message from the same person also reached `mm-deploy-bot`, as a channel follow-up to that tagged exchange, which takes precedence over auto-route by design.)
- `!auto-route fallback @mm-triage-bot` → "While the decision service is failing, messages auto-route could not decide go to **mm-triage-bot**…".
- With the service still down, untagged "our nightly release did not go out…" → only `mm-triage-bot`, with `routed=True routed_reason=fallback` on the event; log `agent=mm-triage-bot routed_reason=fallback outcome=delivered`. This post came after the Mac had slept for 1 h 37 min, more than an hour after the first notice, so a second notice was posted — the hourly limit expiring, as specified. The next untagged question a few seconds later went to the triage agent again with no notice.
- After restarting the decision service, an untagged README question went to `mm-docs-bot` as `decided` again.
- Evidence: `j4-mattermost-service-down-notice-and-fallback.png` (notice, tagged answer, fallback answers).
- Not seen: the Console room-prompt framing of a fallback delivery ("auto-route was unavailable, so this came to you as the room's triage agent"). The agents here are scripted, not Console sessions, so only the `routed_reason: "fallback"` field that drives the framing was checked.

## Journey 5: restart mid-decision — PASS

- Paused the decision service with `SIGSTOP`, so the request hangs. Untagged "the release to production is blocked on a failing deploy check…" → a `pending_decisions` row (`room_seq 47`, `claimed_until` 90 s after the claim).
- Stopped switch-core (SIGTERM) with the decision in flight, resumed the decision service, started switch-core again (17:32:50 → 17:32:54). The row survived the restart. When the dead worker's claim lapsed (17:34:11) the sweep picked it up: `choice=mm-deploy-bot … backend=server_default`, `outcome=delivered`, and `mm-deploy-bot` received it as addressed exactly once (17:34:15, 94 s after the post). No duplicate.
- Expiry: restarted with `DECISION_PENDING_MAX_AGE_SECONDS=20`, paused the service, posted "who can retry the failed staging deploy from this morning?" (row written), stopped switch-core for about a minute, then started it. Log: `outcome=expired reason=it waited more than 20s for a decision (the server was down or busy), so no agent receives it`. No agent received it, the triage agent included, and the table was empty afterwards.
- Note: after a crash or restart, a pending message waits for the old claim to lapse (about 90 s) before it is decided, so with the default 120 s age limit the window in which it can still be delivered is about 30 s.

## Journey 6: room toggle matches `!auto-route` — PASS (gateway here, Console in the 3.3 section)

- Gateway web app as alice, `ar-a1` (auto-route on): clicked the Auto-route switch → `PUT /gateway/rooms/{id}/auto-route` 200 `{"on":false,…}`; `!auto-route` in Mattermost then answered "Automatic routing is **off** in this room…". Evidence: `j6-gateway-before-toggle-on.png`, `j6-gateway-after-toggle-off.png`.
- Reverse: `!auto-route on` in Mattermost, then a fresh load of the gateway room page shows the switch **On** and the triage agent `mm-triage-bot` that `!auto-route fallback @mm-triage-bot` had set. Evidence: `j6-gateway-after-command-on.png`, `j6-mattermost-commands.png`.
- Clearing the triage agent through the same room route (`{"fallback_agent": null}`) → `!auto-route fallback` answers "This room has no triage agent…".
- Unavailable state in the gateway: journey 1 (`j1-gateway-room-unavailable.png`, switch disabled while off) and journey 3 (`j3-gateway-roomB-unavailable-after-none.png`, switch still on so it can be turned off, reason shown).

## Task 3.3 and journey 6 in Switch Console — PASS

Console from the branch, run in dev mode with its own data folder (`SWITCH_CONSOLE_USER_DATA_DIR=switchdash-drv`, `SWITCHDASH_DB_FILE=/tmp/drv/console-drv.db`, `--use-mock-keychain`) so the owner's Console data was not touched, driven with Playwright over the renderer's remote-debugging port, signed in with a password as alice and then beth.

| Check | Result | Evidence |
|---|---|---|
| A shows the server default (`http://127.0.0.1:8250`) | PASS | `console-A-server-default.png` |
| Test | PASS: deploy-bot, 1.00, 0.54 s | `console-A-test.png` |
| Save Haiku (Anthropic) with the key | PASS: "set, ending in cwAA", key field empty | `console-A-haiku-saved.png` |
| Test Haiku | PASS: deploy-bot, 0.95, 1.97 s | `console-A-haiku-test.png` |
| "Use server default" | PASS: A's row removed (checked through the API) | `console-A-reset.png` |
| B as beth: its own setting | PASS: "own setting applies: None" with the unavailable reason | `console-B-none.png` |
| beth in Default (member): no Decision routing entry; switching Default ↔ B changes it | PASS | `console-member-hidden.png` |
| `ar-a1` toggle off in Console → `!auto-route` says off | PASS | `console-room-toggle-off.png` |
| `!auto-route on` → Console shows On after reload | PASS | `console-room-toggle-on-after-command.png` |

UI notes (not bugs in the API; worth a look):
- Without `SWITCH_CLOUD_URL` Console offers only the server menu, so a second workspace on a self-hosted server can't be opened from Console; the walk needed `SWITCH_CLOUD_URL=http://localhost:8000` (by design in `workspace-switcher.tsx`, `showsServers`).
- After "Use server default", the previous Haiku test result stays on screen.
- In B, Save is enabled with nothing changed.
- The first Console start, before `--use-mock-keychain`, raised a macOS "Electron Safe Storage" keychain prompt (SecurityAgent) that is still waiting on the owner's screen; it needs a click on Deny.

## Task 2.6: settings API with curl as two workspace admins — PASS

Covered in journey 3 (`j3-curl.log`): alice saved, tested and cleared A's setting; beth read and saved B's; each change took effect on that workspace's next untagged message without a restart (A: Haiku then server default; B: server default then none) and never on the other workspace's; cross-workspace reads and writes were refused (403).

## Task 6.2: telemetry — PASS

switch-core ran with `TELEMETRY_ENABLED=true` pointed at a local OTLP sink on :4319 (`/tmp/drv/telemetry_sink.py`), which recorded every product event posted. `telemetry-decision-events.json` holds the 12 decision events it received (8 `switch_core.decision_made`, 4 `switch_core.decision_failed`; events after the last flush were still buffered). Each carries only `backend` (`server_default` / `haiku_anthropic`), `outcome` (`agent` / `none`), `confidence` (a bucket such as `0.9_1.0`) and `latency_ms`, or `backend` and `reason` (`unreachable`). Searching the whole capture for the room ids, agent names, message ids (`sw_…`), message words ("invoice", "roll it back"), the user's name and the key's last 4 found nothing.

## Task 7.3: one-flag deployment — PARTLY (helm template only)

- `kind` is not installed on this Mac, so there was no `helm install --dry-run` against a cluster. Instead: `helm template` of the chart **as committed at `9da9f9751`** with `decision.enabled=true` (`helm-template-decision-enabled.txt`): a NetworkPolicy `rel-decision` admitting only pods with `app.kubernetes.io/component: switch-core` of the same release on TCP 8230; the decision pod's `decision` container (`DECISION_BACKEND=llamacpp`, `LLAMACPP_URL=http://127.0.0.1:8300`, no GPU) and `model-server` container (`nvidia.com/gpu: 1`); switch-core gets `DECISION_ENDPOINT_URL=http://rel-decision:8230`. `scripts/check_chart_decision.py` passes against that commit (`helm-check-chart-decision-HEAD.txt`).
- The worktree had uncommitted chart changes from another session (making Strands Decider 4B the default) while this ran, and `check_chart_decision.py` fails on the worktree (`KeyError: 'LLAMACPP_URL'`, its test still expects llama.cpp); a later commit `3d5dbae63` landed during the walk. Whoever finishes that change needs to re-run the check.
- Compose `decision` profile: not re-run here (memory on the Mac was tight with Qwen and Clef loaded). The deploy stream's earlier run of the profile on port 18230 scored 14/15 at 5.1 s per decision on CPU; journey 2 here ran the same service code on the host instead.

## Slack (second platform, journeys 2 and 4) — PASS

- Typed as a person in the owner's Slack test workspace through the Slack test Chrome (`--remote-debugging-port=9333`), channel `#routing-demo-2` (auto-route on, the three real controller-run Claude agents): "the staging deploy is stuck on the migrate step again, can someone roll it back?". Log: `candidates=3 choice=deploy-bot confidence=0.98 latency_ms=1966 model=qwen3.5-4b-q4_k_m backend=server_default`, `agent=deploy-bot routed_reason=decided outcome=delivered`. Slack shows deploy-bot's "Starting a session to handle this — one moment." Evidence: `slack-j2-deploy-question.png`, `slack-j2-deploy-answer.png` (the caption bar at the bottom is left over from an earlier recording in that browser).
- deploy-bot (a real Claude agent run by the owner's agent controller) answered in the channel five minutes later (17:47, "Staging deploy rolled back…"). The delay is that controller's socket dropping every ~20 s against the rebased server (see observations), not decision routing.
- Journey 4 on Slack: with the decision service stopped, untagged "is anyone looking at the failed deploy from this morning?" → no agent, one notice from Switch ("Auto-route is unavailable right now; tag an agent to reach it."); "and the billing export is late too" right after → no agent, no second notice. Log: `outcome=nobody reason=the decision service failed (unreachable) and the room has no triage agent` for both. Evidence: `slack-j4-one-notice-and-j2-answer.png` (also shows deploy-bot's answer), `slack-j4-service-down-notice.png`.

## Not walked, and why

- **GPU latency (under 1 s on an L4) and journey 7 (napoleon development):** no NVIDIA GPU on this Mac and out of scope for this walk. Decisions here ran on Qwen3.5-4B under llama.cpp on the Mac's GPU: 0.4–2.0 s through the Test button and in rooms.
- **Haiku on Bedrock:** no AWS credentials in this stack; `options.haiku_bedrock` was false, as specified without `DECISION_BEDROCK_ENABLED`.
- **`helm install --dry-run` against kind:** kind isn't installed; `helm template` evidence only.
- **Compose `decision` profile on the Mac:** not re-run (memory); the deploy stream's earlier run stands.
- **Console's fallback framing text** for the triage agent: the agents were scripted, so only the `routed_reason: "fallback"` field was checked.
- **The published dev image (tasks 1.5, 1.7):** no CI dev build yet.

## Observations

- Mattermost 12.0.0 runs as amd64 under qemu in colima on this Mac and segfaulted twice when switch-core uploaded bot icons (`[BOT-ICON]`); switch-core was then run with `THIRD_PARTY_AVATARS_ENABLED=false` for the walk. Not related to this change.
- A user invited as `admin` to the Default workspace stayed `member`, because new users already join Default as members and accepting did not raise the role; promoted by the operator. Pre-existing, not this change.
- **Agent controller flapping (pre-existing on main, affects this stack):** since the branch core replaced the old one, the controller running the owner's Slack agents logs "The controller socket is down; reconnecting … Nothing on the controller socket for 10 s" about every 20 s (3 an hour before). Upstream `c33b46980` (#643) moved the server's ping to every 10 s (`core/switch_core/bridges/agent/protocol/liveness.py:25`), and the controller's stream idle timeout is also 10 s (`console/packages/agent-controller/src/controller.ts:72`), so a ping arriving a moment late trips it. The running controller predates that change; the current controller source has the same 10 s, so it likely flaps too. Not this change; worth a ticket.
- With `THIRD_PARTY_AVATARS_ENABLED=false` (set only for the walk, to keep Mattermost alive) Slack showed deploy-bot with a default avatar; restored when switch-core was restarted without it.
- The router's decision log lines for a room in workspace B carry `tenant_id=default` in their log context (the worker runs outside a request), so the log context doesn't say which workspace decided; the room id does. Minor, not fixed.
- After the final restart, switch-core logged one `RuntimeError: No incarnation drawn: a connection is opened inside a recorded move` (`bridges/agent/protocol/connection_rows.py:194`) as the scripted agents reconnected at once. Agent connection code, not this change.
- No bugs were found in the change itself; no code was changed or committed.

## State left running

- switch-core from the branch (`9da9f9751`) on :8000 (`/tmp/drv/start-core.sh http://127.0.0.1:8250`; log `/tmp/drv/core.log`), against the shared Postgres, migrated to `689d7d8ff913`, with the same flags as before plus `CONTROLLER_TOKEN_SECRET` (a new value in `/tmp/drv/controller-secret`; the old process's value was not recoverable, and the owner's agent controller re-exchanged its credential and reconnected). Slack bridge active; Default (A) has no decision setting, so it uses the server default.
- The branch decision service on :8250 → Qwen on :8300 (log `/tmp/drv/decision-8250.log`).
- Removed after the walk: the two verification Mattermost bridges (and with them rooms `ar-a1`, `ar-b1`); the Mattermost containers (`switch-drv`, stopped, volumes kept), the telemetry sink and the gateway dev server are stopped. Left in the database: users alice and beth, Workspace B (setting `none`), and the offline scripted agents.
