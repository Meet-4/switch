import asyncio
import json

import pytest
from starlette.types import Message, Receive, Scope, Send

from switch_core import open_gate
from switch_core.open_gate import MIN_RETRY_S, OpenGate


class _Socket:
    """An agent socket: accepted, then a first frame once `opened` is set, then
    a stream that runs until `ended` is set. Counts the opens that reached it."""

    def __init__(self) -> None:
        self.opened = asyncio.Event()
        self.ended = asyncio.Event()
        self.calls = 0

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        self.calls += 1
        await receive()
        await send({"type": "websocket.accept"})
        await self.opened.wait()
        await send({"type": "websocket.send", "text": '{"event": "connection_state"}'})
        await self.ended.wait()
        await send({"type": "websocket.close", "code": 1000})


class _Answer:
    """Answers every HTTP request at once, and counts them."""

    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        self.calls += 1
        await send({"type": "http.response.start", "status": 201, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _socket_scope(
    token: str = "token-a", path: str = "/agents/a1/connection/ws"
) -> Scope:
    return {
        "type": "websocket",
        "path": path,
        "headers": [(b"authorization", f"Bearer {token}".encode())],
    }


async def _open(gate: OpenGate, scope: Scope) -> list[Message]:
    sent: list[Message] = []

    async def receive() -> Message:
        return {"type": "websocket.connect"}

    async def send(message: Message) -> None:
        sent.append(message)

    await gate(scope, receive, send)
    return sent


def _refusal(sent: list[Message]) -> dict:
    assert [m["type"] for m in sent] == [
        "websocket.accept",
        "websocket.send",
        "websocket.close",
    ]
    assert sent[2]["code"] == 4503
    frame = json.loads(sent[1]["text"])
    assert frame["event"] == "refused"
    assert frame["data"]["status"] == 503
    return frame["data"]["detail"]


@pytest.fixture(autouse=True)
def _short_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(open_gate, "WAIT_S", 0.05)


async def test_an_open_past_the_limit_waits_for_a_slot_and_then_runs() -> None:
    app = _Socket()
    gate = OpenGate(app, limit=1, clock=_Clock())
    first = asyncio.create_task(_open(gate, _socket_scope("token-a")))
    await asyncio.sleep(0)
    second = asyncio.create_task(_open(gate, _socket_scope("token-b")))
    await asyncio.sleep(0.01)
    assert app.calls == 1

    # The first open's first frame frees its slot, though its stream goes on.
    app.opened.set()
    await asyncio.sleep(0.01)
    assert app.calls == 2

    app.ended.set()
    await asyncio.gather(first, second)


async def test_an_open_that_finds_no_slot_in_time_is_told_when_to_come_back() -> None:
    app = _Socket()
    gate = OpenGate(app, limit=1, clock=_Clock())
    first = asyncio.create_task(_open(gate, _socket_scope("token-a")))
    await asyncio.sleep(0)

    detail = _refusal(await _open(gate, _socket_scope("token-b")))
    assert detail["code"] == "busy"
    assert detail["retry_after_s"] >= MIN_RETRY_S
    assert app.calls == 1  # refused before authentication or anything else

    app.opened.set()
    app.ended.set()
    await first


async def test_refused_opens_are_given_times_one_slot_apart_in_arrival_order() -> None:
    clock = _Clock()
    gate = OpenGate(_Answer(), limit=4, clock=clock, rand=lambda: 0.0)
    times = [gate._retry_after(f"caller-{n}") for n in range(5)]
    spacing = open_gate.FIRST_OPEN_S / 4
    assert times[0] == pytest.approx(MIN_RETRY_S)
    for earlier, later in zip(times, times[1:], strict=False):
        assert later - earlier == pytest.approx(spacing)


async def test_a_caller_refused_again_before_its_time_keeps_its_time() -> None:
    clock = _Clock()
    gate = OpenGate(_Answer(), limit=1, clock=clock, rand=lambda: 0.0)
    for n in range(10):
        gate._retry_after(f"caller-{n}")
    first = gate._retry_after("late")
    clock.now += 1.0
    # Back too early, as a client that ignores the hint is: the same moment,
    # and the queue behind it does not move.
    assert gate._retry_after("late") == pytest.approx(first - 1.0)
    assert gate._retry_after("next") == pytest.approx(
        first + open_gate.FIRST_OPEN_S - 1.0
    )


async def test_the_slots_spread_out_when_opens_take_longer() -> None:
    clock = _Clock()
    app = _Socket()
    gate = OpenGate(app, limit=1, clock=clock, rand=lambda: 0.0)
    task = asyncio.create_task(_open(gate, _socket_scope()))
    await asyncio.sleep(0)
    clock.now += 2.0  # this open takes 2 s
    app.opened.set()
    app.ended.set()
    await task
    first = gate._retry_after("a")
    second = gate._retry_after("b")
    expected = open_gate.FIRST_OPEN_S + open_gate.OPEN_S_WEIGHT * (
        2.0 - open_gate.FIRST_OPEN_S
    )
    assert second - first == pytest.approx(expected)


async def test_a_controller_open_is_refused_in_the_management_envelope() -> None:
    answer = _Answer()
    gate = OpenGate(answer, limit=1, clock=_Clock())
    await gate._slots.acquire()  # an open already running

    sent: list[Message] = []

    async def receive() -> Message:
        return {"type": "http.request", "body": b"{}", "more_body": False}

    async def send(message: Message) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/v1/controllers/c1/connection",
        "headers": [(b"authorization", b"Bearer ctl-token")],
    }
    await gate(scope, receive, send)
    assert sent[0]["status"] == 503
    headers = dict(sent[0]["headers"])
    error = json.loads(sent[1]["body"])["error"]
    assert error["code"] == "busy"
    assert error["retryable"] is True
    assert int(headers[b"retry-after"]) >= error["retry_after_s"]
    assert answer.calls == 0


async def test_other_routes_and_a_limit_of_0_are_not_paced() -> None:
    answer = _Answer()
    gate = OpenGate(answer, limit=1, clock=_Clock())

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Message) -> None:
        pass

    # Every slot taken, yet a message post is not an open and goes straight in.
    await gate._slots.acquire()
    post = {
        "type": "http",
        "method": "POST",
        "path": "/agents/a1/message",
        "headers": [],
    }
    await gate(post, receive, send)
    assert answer.calls == 1

    off = OpenGate(answer, limit=0, clock=_Clock())
    opening = {
        "type": "http",
        "method": "POST",
        "path": "/v1/controllers/c1/connection",
        "headers": [],
    }
    await off(opening, receive, send)
    assert answer.calls == 2
