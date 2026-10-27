"""People in rooms with no messaging app, and rooms moved off a retired
Mattermost connector: both reach their people through Switch Console
membership — against real Postgres, through the shared harness."""

from __future__ import annotations

from sqlalchemy import select

from switch_core.chats.views import chat_summary
from switch_core.db.models import (
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    User,
)
from switch_core.room_service import RoomCreateConfig
from tests.switch_core.gateway.conftest import _Harness


async def _in_room(chats: _Harness, room_id: str, user: User) -> bool:
    async with chats.factory() as session:
        return room_id in {
            room.id for room in await chats.service.readable_rooms(session, user.id)
        }


async def _listed(chats: _Harness, room_id: str, user: User) -> bool:
    async with chats.factory() as session:
        return room_id in {
            room.id for room in await chats.service.stream_rooms(session, user.id)
        }


async def _agentless_room(chats: _Harness, name: str) -> Room:
    created = await chats.room_service.create_room(
        RoomCreateConfig(name=name, description="d", internal_only=True)
    )
    return created.room


async def test_a_room_with_no_bridge_takes_its_people_and_creator(
    chats: _Harness,
) -> None:
    agent = await chats.agent("claude-code.helper", owner=chats.alice)

    created = await chats.room_service.create_room(
        RoomCreateConfig(
            name="plans",
            description="d",
            agent_ids=[agent.id],
            user_names=["bob", "nobody", "carol"],
            created_by=chats.alice.id,
            owner_id=chats.alice.id,
        )
    )

    assert created.room.bridge_id is None
    assert await _in_room(chats, created.room.id, chats.alice)
    assert await _in_room(chats, created.room.id, chats.bob)
    # carol has no role in the workspace, so her name resolves to nobody.
    assert not await _in_room(chats, created.room.id, chats.carol)
    assert sorted(f["id"] for f in created.failed_attachments) == ["carol", "nobody"]


async def test_adding_people_to_a_room_with_no_bridge(chats: _Harness) -> None:
    room = await _agentless_room(chats, "ops")

    unresolved = await chats.room_service.add_users_to_room(
        room.id, ["bob@example.com", "ghost"]
    )

    assert unresolved == ["ghost"]
    assert await _in_room(chats, room.id, chats.bob)


async def _retiring_bridge(chats: _Harness, room: Room) -> CollaborationBridge:
    async with chats.factory() as session:
        bot = Client(
            transport_user_id="@mm-bot:switch.test", display_name="bot", type="bridge"
        )
        session.add(bot)
        await session.flush()
        bridge = CollaborationBridge(
            tenant_id=room.tenant_id,
            type="mattermost",
            display_name="Mattermost",
            connection_config={},
            client_id=bot.id,
            status="retiring",
        )
        session.add(bridge)
        await session.flush()
        row = await session.get(Room, room.id)
        assert row is not None
        row.bridge_id = bridge.id
        row.external_channel_id = "mm-chan"
        await session.commit()
        return bridge


async def _person_on(
    chats: _Harness,
    bridge: CollaborationBridge,
    name: str,
    *,
    in_room: Room | None,
    claimed_by: User | None,
) -> None:
    async with chats.factory() as session:
        actor = Client(
            transport_user_id=f"@mm-{name}:switch.test", display_name=name, type="human"
        )
        session.add(actor)
        await session.flush()
        external = ExternalUser(
            bridge_id=bridge.id,
            external_user_id=f"mm-{name}",
            external_username=name,
            client_id=actor.id,
        )
        session.add(external)
        await session.flush()
        if in_room is not None:
            session.add(ClientRoom(client_id=actor.id, room_id=in_room.id))
        if claimed_by is not None:
            session.add(
                ExternalUserClaim(external_user_id=external.id, user_id=claimed_by.id)
            )
        await session.commit()


async def test_a_retired_mattermost_room_moves_to_its_linked_people(
    chats: _Harness,
) -> None:
    room = await _agentless_room(chats, "Mattermost: town-square")
    bridge = await _retiring_bridge(chats, room)
    # bob's account was in the room and is linked to him.
    await _person_on(chats, bridge, "bob", in_room=room, claimed_by=chats.bob)
    # Someone in the room whose account nobody linked.
    await _person_on(chats, bridge, "stranger", in_room=room, claimed_by=None)
    # alice is linked on the connector, but was never in the room.
    await _person_on(chats, bridge, "alice", in_room=None, claimed_by=chats.alice)

    await chats.room_service.retire_mattermost_bridges()

    # Listed with no agent in it, on the strength of where it came from.
    assert await _listed(chats, room.id, chats.bob)
    assert not await _in_room(chats, room.id, chats.alice)
    async with chats.factory() as session:
        row = await session.get(Room, room.id)
        stored = await session.get(CollaborationBridge, bridge.id)
        assert row is not None and stored is not None
        assert (row.bridge_id, row.external_channel_id) == (None, None)
        assert row.metadata_["retired_bridge"] == {
            "type": "mattermost",
            "bridge_id": bridge.id,
            "external_channel_id": "mm-chan",
        }
        assert stored.status == "inactive"
        summary = await chat_summary(
            session, row, viewer_id=chats.bob.id, can_manage=False
        )
        assert summary.bridge_type is None
        members = set(
            (
                await session.execute(
                    select(ClientRoom.client_id).where(ClientRoom.room_id == room.id)
                )
            ).scalars()
        )

    await chats.room_service.retire_mattermost_bridges()

    async with chats.factory() as session:
        assert (
            set(
                (
                    await session.execute(
                        select(ClientRoom.client_id).where(
                            ClientRoom.room_id == room.id
                        )
                    )
                ).scalars()
            )
            == members
        )


async def test_a_chat_on_a_bridge_that_is_not_active_names_no_platform(
    chats: _Harness,
) -> None:
    room = await _agentless_room(chats, "old")
    bridge = await _retiring_bridge(chats, room)
    async with chats.factory() as session:
        stored = await session.get(CollaborationBridge, bridge.id)
        row = await session.get(Room, room.id)
        assert stored is not None and row is not None
        stored.status = "inactive"
        await session.commit()
        summary = await chat_summary(
            session, row, viewer_id=chats.alice.id, can_manage=False
        )

    assert summary.bridge_type is None
    assert summary.channel_name is None
