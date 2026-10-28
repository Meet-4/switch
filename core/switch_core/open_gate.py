"""Paces connection opens, so a reconnect storm becomes a queue.

When a pod goes away, every agent and controller it held opens a connection on
the pods that are left, all within a few seconds. Each open authenticates,
makes a new incarnation of the connection and reads where the stream starts:
dozens of transactions, on the same pool the process's requests and its own
lease renewal use. Measured on staging (two pods, 1,000 agents, one pod
deleted), the opens took the whole pool: thousands of pool timeouts, opens
that failed after their incarnation was made, and the surviving pod's lease
lapsing, which made it drop agents of its own.

This middleware lets at most `limit` opens run at once in this process. An
open that finds every slot taken waits up to `WAIT_S` for one. Past that, or
when `MAX_WAITING` opens are waiting already, it is refused before
authentication or the database, with `retry_after_s`: a time this process hands
out in order, one slot after another, so a storm comes back spread over the
time the process needs to take it rather than all at once. The slots are as far
apart as opens are taking here, so the queue slows down when the database
does. A caller refused again before its time is given the same time, not a
new one, so a client that retries at once cannot push everyone else's back.

An open is done when its first frame or response body goes out (the
`connection_state`, or a refusal) or the request ends. What follows is the
stream, which the event buffer's own cap paces. The state is this process's
own: each pod paces its own opens, as each has its own pool.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import random
import re
from collections import OrderedDict
from collections.abc import Callable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from switch_core.observability.catalogue import AGENT_OPENS_DEFERRED
from switch_core.observability.metrics import metrics

logger = logging.getLogger(__name__)

# How long an open waits for a slot before it is told to come back later.
WAIT_S = 2.0
# Opens waiting for a slot at once; past this, refused without waiting.
MAX_WAITING = 64
# The earliest and latest time a refused open is told to come back in.
MIN_RETRY_S = 1.0
MAX_RETRY_S = 300.0
# What an open is taken to cost before any has finished here, and the weight
# each finished one gets in the running average.
FIRST_OPEN_S = 0.25
OPEN_S_WEIGHT = 0.2
# Bounds the memory callers retrying with fresh tokens can take.
MAX_TRACKED = 10_000
# The most often a summary of refused opens is logged.
LOG_EVERY_S = 10.0

BUSY = "busy"
_STATUS = 503

# The opens it paces, by the label its metric carries.
_ROUTES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"^/agents/[^/]+/connection/ws$"), "agent_socket"),
    (re.compile(r"^/agents/[^/]+/events$"), "agent_event_stream"),
    (re.compile(r"^/v1/controllers/[^/]+/connection$"), "controller_open"),
    (re.compile(r"^/v1/controllers/[^/]+/connection/ws$"), "controller_socket"),
)
# Controllers read refusals from the management error envelope; everything
# else on this app reads FastAPI's `detail`.
_MANAGEMENT_PREFIXES = ("/v1/controllers/", "/v1/management/")


def _route(scope: Scope) -> str | None:
    if scope["type"] not in ("http", "websocket"):
        return None
    path = scope.get("path", "")
    if scope["type"] == "http" and scope.get("method") not in ("GET", "POST"):
        return None
    for pattern, label in _ROUTES:
        if pattern.match(path):
            return label
    return None


class OpenGate:
    def __init__(
        self,
        app: ASGIApp,
        *,
        limit: int,
        clock: Callable[[], float],
        rand: Callable[[], float] = random.random,
    ) -> None:
        self.app = app
        self.limit = limit
        self._clock = clock
        self._rand = rand
        self._slots = asyncio.Semaphore(max(limit, 1))
        self._waiting = 0
        self._open_s = FIRST_OPEN_S
        self._next_at = 0.0
        self._given: OrderedDict[str, float] = OrderedDict()
        self._deferred = 0
        self._logged_at = 0.0

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        route = _route(scope) if self.limit > 0 else None
        if route is None:
            await self.app(scope, receive, send)
            return
        if not await self._enter():
            retry_after_s = self._retry_after(_caller(scope))
            metrics().increment(AGENT_OPENS_DEFERRED, {"route": route})
            self._note_deferred(retry_after_s)
            await _refuse(scope, receive, send, retry_after_s)
            return

        started = self._clock()
        released = False

        def release() -> None:
            nonlocal released
            if released:
                return
            released = True
            took = max(self._clock() - started, 0.0)
            self._open_s += OPEN_S_WEIGHT * (took - self._open_s)
            self._slots.release()

        async def done_on_first_output(message: Message) -> None:
            if message["type"] in (
                "websocket.send",
                "websocket.close",
                "http.response.body",
            ):
                release()
            await send(message)

        try:
            await self.app(scope, receive, done_on_first_output)
        finally:
            release()

    async def _enter(self) -> bool:
        if not self._slots.locked():
            await self._slots.acquire()
            return True
        if self._waiting >= MAX_WAITING:
            return False
        self._waiting += 1
        try:
            async with asyncio.timeout(WAIT_S):
                await self._slots.acquire()
            return True
        except TimeoutError:
            return False
        finally:
            self._waiting -= 1

    def _retry_after(self, caller: str | None) -> float:
        """The next free slot in this process's queue, as seconds from now.

        Slots are `open_s / limit` apart: how long an open takes here, over how
        many run at once. A caller already given a time that has not come is
        given the same one."""
        now = self._clock()
        if caller is not None:
            at = self._given.get(caller)
            if at is not None and at > now:
                self._given.move_to_end(caller)
                return max(at - now, MIN_RETRY_S)
        spacing = self._open_s / max(self.limit, 1)
        start = max(now + MIN_RETRY_S, self._next_at)
        self._next_at = start + spacing
        at = min(start + spacing * self._rand(), now + MAX_RETRY_S)
        if caller is not None:
            self._given[caller] = at
            self._given.move_to_end(caller)
            while len(self._given) > MAX_TRACKED:
                self._given.popitem(last=False)
        return at - now

    def _note_deferred(self, retry_after_s: float) -> None:
        self._deferred += 1
        now = self._clock()
        if now - self._logged_at < LOG_EVERY_S:
            return
        logger.warning(
            "Deferred %d connection open(s) since the last report: %d running "
            "(the limit), %d waiting, the latest told to come back in %.1f s",
            self._deferred,
            self.limit,
            self._waiting,
            retry_after_s,
        )
        self._deferred = 0
        self._logged_at = now


def _caller(scope: Scope) -> str | None:
    for name, value in scope.get("headers", []):
        if name == b"authorization" and value.lower().startswith(b"bearer "):
            return hashlib.sha256(value[7:].strip()).hexdigest()
    return None


async def _refuse(
    scope: Scope, receive: Receive, send: Send, retry_after_s: float
) -> None:
    """Refuse the open in the form its client reads refusals in, with when to
    come back."""
    seconds = round(retry_after_s, 1)
    message = (
        "This server is opening as many connections as it can take right now. "
        f"Open again in {seconds} s."
    )
    path = scope.get("path", "")
    if scope["type"] == "websocket":
        # As every refused agent or controller socket: accepted, a `refused`
        # frame with the status and detail, then closed with 4000 plus it.
        await receive()  # the client's websocket.connect
        await send({"type": "websocket.accept"})
        frame = {
            "event": "refused",
            "data": {
                "status": _STATUS,
                "detail": {
                    "code": BUSY,
                    "message": message,
                    "retry_after_s": seconds,
                },
            },
        }
        await send({"type": "websocket.send", "text": json.dumps(frame)})
        await send({"type": "websocket.close", "code": 4000 + _STATUS})
        return
    if path.startswith(_MANAGEMENT_PREFIXES):
        body: dict[str, object] = {
            "error": {
                "code": BUSY,
                "message": message,
                "retryable": True,
                "retry_after_s": seconds,
            }
        }
    else:
        body = {"detail": {"code": BUSY, "message": message, "retry_after_s": seconds}}
    payload = json.dumps(body).encode()
    await send(
        {
            "type": "http.response.start",
            "status": _STATUS,
            "headers": [
                (b"content-type", b"application/json"),
                (b"retry-after", str(math.ceil(retry_after_s)).encode()),
                (b"content-length", str(len(payload)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})
