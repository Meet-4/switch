from collections.abc import Collection
from datetime import datetime
from typing import Any, cast

from sqlalchemy import CursorResult, delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.account_links import (
    LINK_CODE_TTL,
    hash_link_code,
    new_link_code,
    normalise_link_code,
)
from switch_core.db.models import (
    Client,
    ClientRoom,
    ExternalUser,
    ExternalUserClaim,
    ExternalUserLinkRequest,
    TenantMember,
)


class ExternalUserStore:
    async def create(self, session: AsyncSession, user: ExternalUser) -> ExternalUser:
        session.add(user)
        await session.flush()
        return user

    async def is_bridge_user(
        self, session: AsyncSession, bridge_id: str, transport_user_id: str
    ) -> bool:
        """Whether `transport_user_id` is the human actor of a person on this
        bridge."""
        result = await session.execute(
            select(ExternalUser.id)
            .join(Client, Client.id == ExternalUser.client_id)
            .where(
                ExternalUser.bridge_id == bridge_id,
                Client.transport_user_id == transport_user_id,
            )
            .limit(1)
        )
        return result.scalar_one_or_none() is not None

    async def get(self, session: AsyncSession, user_id: str) -> ExternalUser | None:
        return await session.get(ExternalUser, user_id)

    async def rename(
        self, session: AsyncSession, user_id: str, external_username: str
    ) -> None:
        """Correct the name a person is filed under on their bridge.

        Their `external_user_id` is what identifies them and does not change,
        so claims and room membership are untouched; this is only the label —
        which matters because it is what agents address them by.
        """
        user = await session.get(ExternalUser, user_id)
        if user is not None:
            user.external_username = external_username

    async def get_by_external_id(
        self, session: AsyncSession, bridge_id: str, external_user_id: str
    ) -> ExternalUser | None:
        result = await session.execute(
            select(ExternalUser).where(
                ExternalUser.bridge_id == bridge_id,
                ExternalUser.external_user_id == external_user_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_by_bridge(
        self, session: AsyncSession, bridge_id: str
    ) -> list[ExternalUser]:
        result = await session.execute(
            select(ExternalUser).where(ExternalUser.bridge_id == bridge_id)
        )
        return list(result.scalars().all())

    async def get_by_bridges(
        self, session: AsyncSession, bridge_ids: Collection[str]
    ) -> list[ExternalUser]:
        """`get_by_bridge` for several bridges in one query."""
        if not bridge_ids:
            return []
        result = await session.execute(
            select(ExternalUser).where(ExternalUser.bridge_id.in_(bridge_ids))
        )
        return list(result.scalars().all())

    async def get_by_bridge_and_names(
        self, session: AsyncSession, bridge_id: str, usernames: list[str]
    ) -> list[ExternalUser]:
        if not usernames:
            return []
        result = await session.execute(
            select(ExternalUser).where(
                ExternalUser.bridge_id == bridge_id,
                ExternalUser.external_username.in_(usernames),
            )
        )
        return list(result.scalars().all())

    async def get_by_client_id(
        self, session: AsyncSession, client_id: str
    ) -> ExternalUser | None:
        result = await session.execute(
            select(ExternalUser).where(ExternalUser.client_id == client_id)
        )
        return result.scalar_one_or_none()

    async def get_by_room(
        self, session: AsyncSession, room_id: str
    ) -> list[ExternalUser]:
        result = await session.execute(
            select(ExternalUser)
            .join(ClientRoom, ClientRoom.client_id == ExternalUser.client_id)
            .where(ClientRoom.room_id == room_id)
        )
        return list(result.scalars().all())

    async def get_by_user(
        self, session: AsyncSession, switch_user_id: str
    ) -> list[ExternalUser]:
        """Every platform identity claimed by this Switch user, across bridges."""
        result = await session.execute(
            select(ExternalUser)
            .join(
                ExternalUserClaim,
                ExternalUserClaim.external_user_id == ExternalUser.id,
            )
            .where(ExternalUserClaim.user_id == switch_user_id)
        )
        return list(result.scalars().all())

    async def claimant_ids(
        self, session: AsyncSession, external_user_id: str
    ) -> list[str]:
        """The Switch users who have claimed this platform identity.

        More than one is allowed and expected: see `ExternalUserClaim`.
        """
        result = await session.execute(
            select(ExternalUserClaim.user_id).where(
                ExternalUserClaim.external_user_id == external_user_id
            )
        )
        return list(result.scalars().all())

    async def claims_of_user(
        self, session: AsyncSession, switch_user_id: str
    ) -> list[tuple[ExternalUser, ExternalUserClaim]]:
        """`get_by_user` with each claim, for callers that show whether it was
        verified."""
        result = await session.execute(
            select(ExternalUser, ExternalUserClaim)
            .join(
                ExternalUserClaim,
                ExternalUserClaim.external_user_id == ExternalUser.id,
            )
            .where(ExternalUserClaim.user_id == switch_user_id)
        )
        return [(external, claim) for external, claim in result.tuples()]

    async def claims_for(
        self, session: AsyncSession, external_user_ids: list[str]
    ) -> dict[str, list[ExternalUserClaim]]:
        """The claims on several identities at once, to avoid a query per row
        when listing a bridge's users."""
        if not external_user_ids:
            return {}
        result = await session.execute(
            select(ExternalUserClaim).where(
                ExternalUserClaim.external_user_id.in_(external_user_ids)
            )
        )
        claims: dict[str, list[ExternalUserClaim]] = {}
        for claim in result.scalars():
            claims.setdefault(claim.external_user_id, []).append(claim)
        return claims

    async def get_claim(
        self, session: AsyncSession, external_user_id: str, switch_user_id: str
    ) -> ExternalUserClaim | None:
        return await session.get(ExternalUserClaim, (external_user_id, switch_user_id))

    async def release(
        self, session: AsyncSession, external_user: ExternalUser, switch_user_id: str
    ) -> bool:
        """Drop one Switch user's claim on this account, and any request to
        link them to it, leaving anyone else's in place.

        Returns whether there was either to drop, so a caller can tell a real
        unlink from a no-op rather than reporting success either way.
        """
        claims = await session.execute(
            delete(ExternalUserClaim).where(
                ExternalUserClaim.external_user_id == external_user.id,
                ExternalUserClaim.user_id == switch_user_id,
            )
        )
        requests = await session.execute(
            delete(ExternalUserLinkRequest).where(
                ExternalUserLinkRequest.external_user_id == external_user.id,
                ExternalUserLinkRequest.user_id == switch_user_id,
            )
        )
        await session.flush()
        return any(
            cast("CursorResult[Any]", result).rowcount > 0
            for result in (claims, requests)
        )

    # ── Link requests (CHOO-3881) ────────────────────────────────────────────

    async def request_link(
        self,
        session: AsyncSession,
        external_user: ExternalUser,
        switch_user_id: str,
        requested_by_user_id: str,
    ) -> ExternalUserLinkRequest:
        """Start linking this account to a Switch user, pending the account's
        confirmation.

        Asking again keeps the request that is already waiting, code and all,
        and only records who asked most recently.
        """
        await session.execute(
            pg_insert(ExternalUserLinkRequest)
            .values(
                external_user_id=external_user.id,
                user_id=switch_user_id,
                requested_by_user_id=requested_by_user_id,
            )
            .on_conflict_do_update(
                index_elements=["external_user_id", "user_id"],
                set_={"requested_by_user_id": requested_by_user_id},
            )
        )
        await session.flush()
        request = await session.get(
            ExternalUserLinkRequest,
            (external_user.id, switch_user_id),
            populate_existing=True,
        )
        if request is None:
            raise RuntimeError("A link request was written but could not be read back")
        return request

    async def get_link_request(
        self, session: AsyncSession, external_user_id: str, switch_user_id: str
    ) -> ExternalUserLinkRequest | None:
        return await session.get(
            ExternalUserLinkRequest, (external_user_id, switch_user_id)
        )

    async def lock_link_request(
        self, session: AsyncSession, external_user_id: str, switch_user_id: str
    ) -> ExternalUserLinkRequest | None:
        """The request as the database has it now, locked until the
        transaction ends.

        For a caller about to change or confirm it while a code may be
        redeemed, or the request cancelled, at the same moment. Read past the
        session's identity map, which may hold a copy from before either.
        """
        result = await session.execute(
            select(ExternalUserLinkRequest)
            .where(
                ExternalUserLinkRequest.external_user_id == external_user_id,
                ExternalUserLinkRequest.user_id == switch_user_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def cancel_link_request(
        self, session: AsyncSession, external_user: ExternalUser, switch_user_id: str
    ) -> bool:
        """Drop a request waiting for the account to confirm it, leaving any
        claim the pair already has (one made before links needed confirming)
        as it is. Returns whether there was a request to drop."""
        result = await session.execute(
            delete(ExternalUserLinkRequest).where(
                ExternalUserLinkRequest.external_user_id == external_user.id,
                ExternalUserLinkRequest.user_id == switch_user_id,
            )
        )
        await session.flush()
        return cast("CursorResult[Any]", result).rowcount > 0

    async def link_requests_of_user(
        self, session: AsyncSession, switch_user_id: str
    ) -> list[tuple[ExternalUser, ExternalUserLinkRequest]]:
        """Every account waiting to confirm a new link to this Switch user.

        Leaves out a request to confirm a claim that already exists, made
        before links needed confirming: that link counts already, and is
        listed with the claims.
        """
        claimed = (
            select(ExternalUserClaim.external_user_id)
            .where(
                ExternalUserClaim.external_user_id
                == ExternalUserLinkRequest.external_user_id,
                ExternalUserClaim.user_id == ExternalUserLinkRequest.user_id,
            )
            .exists()
        )
        result = await session.execute(
            select(ExternalUser, ExternalUserLinkRequest)
            .join(
                ExternalUserLinkRequest,
                ExternalUserLinkRequest.external_user_id == ExternalUser.id,
            )
            .where(ExternalUserLinkRequest.user_id == switch_user_id, ~claimed)
        )
        return [(external, request) for external, request in result.tuples()]

    async def issue_link_code(
        self, session: AsyncSession, request: ExternalUserLinkRequest
    ) -> tuple[str, datetime]:
        """A fresh code for this request, replacing any code issued before.

        Returns the code, which is never stored, and when it stops working.
        """
        code = new_link_code()
        normalised = normalise_link_code(code)
        if normalised is None:
            raise RuntimeError(f"Generated a link code that does not parse: {code!r}")
        request.code_hash = hash_link_code(normalised)
        # The database's clock, since the database's clock is what a redeem
        # compares it to.
        request.code_expires_at = func.now() + LINK_CODE_TTL  # type: ignore[assignment]
        await session.flush()
        await session.refresh(request, ["code_expires_at"])
        if request.code_expires_at is None:
            raise RuntimeError("A link code was issued but its expiry was not stored")
        return code, request.code_expires_at

    async def redeem_link_code(
        self, session: AsyncSession, external_user: ExternalUser, code: str
    ) -> ExternalUserLinkRequest | None:
        """Confirm the link this code was issued for, if it was issued for
        this account, has not expired, and is for someone still a member of
        the workspace.

        The request becomes a verified claim, upgrading an unverified one in
        place. None when nothing matches, which the caller reports without
        saying which part was wrong.

        Membership is checked here as well as when the link was started,
        because a request outlives a member's removal from the workspace and
        the claim it turns into decides who the account is recognised as.
        """
        normalised = normalise_link_code(code)
        if normalised is None:
            return None
        member = (
            select(TenantMember.user_id)
            .where(
                TenantMember.tenant_id == ExternalUserLinkRequest.tenant_id,
                TenantMember.user_id == ExternalUserLinkRequest.user_id,
            )
            .exists()
        )
        request = await session.scalar(
            select(ExternalUserLinkRequest)
            .where(
                ExternalUserLinkRequest.external_user_id == external_user.id,
                ExternalUserLinkRequest.code_hash == hash_link_code(normalised),
                ExternalUserLinkRequest.code_expires_at > func.now(),
                member,
            )
            .with_for_update(of=ExternalUserLinkRequest)
            .execution_options(populate_existing=True)
        )
        if request is None:
            return None
        await self.confirm_link_request(session, request)
        return request

    async def confirm_link_request(
        self, session: AsyncSession, request: ExternalUserLinkRequest
    ) -> None:
        """Turn a request the account has proved into a verified claim.

        Idempotent on the claim, and never a conflict: claiming an account
        someone else has also claimed is allowed by design, and an unverified
        claim of the same pair is upgraded in place. Left to the database
        rather than a read-then-write, so two confirmations race to the same
        row instead of to a primary-key violation.
        """
        await session.execute(
            pg_insert(ExternalUserClaim)
            .values(
                external_user_id=request.external_user_id,
                user_id=request.user_id,
                verified_at=func.now(),
            )
            .on_conflict_do_update(
                index_elements=["external_user_id", "user_id"],
                set_={"verified_at": func.now()},
            )
        )
        await session.delete(request)
        await session.flush()

    async def delete(self, session: AsyncSession, user_id: str) -> None:
        user = await session.get(ExternalUser, user_id)
        if user:
            await session.delete(user)
            await session.flush()

    async def delete_by_bridge(self, session: AsyncSession, bridge_id: str) -> None:
        await session.execute(
            delete(ExternalUser).where(ExternalUser.bridge_id == bridge_id)
        )
        await session.flush()
