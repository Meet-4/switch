import { format } from 'date-fns';
import { Check, Copy } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useModalContext } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import type {
  IssueLinkCodeResult,
  LinkCode,
  LinkedIdentity,
} from '@shared/core/switch-servers/switch-servers';
import { accountHandle } from './link-accounts-prose';
import { switchServersStore } from './switch-servers-store';
import { useMyIdentities } from './use-my-identities';

/** How often to look for the link having been confirmed. Nothing tells the app
 * when the code is posted, so it asks. */
export const LINK_CONFIRMATION_POLL_MS = 3000;

/** How long "Linked" stays on screen before the caller moves on, so the
 * confirmation is seen rather than inferred from the dialog vanishing. */
const CONFIRMED_HOLD_MS = 1200;

/**
 * The link being confirmed.
 *
 * `pending` counts for nothing until the code is posted, and cancelling drops
 * it. `unverified` was made before links had to be confirmed and already
 * counts, so there is nothing to cancel — walking away leaves it as it was.
 */
export type AccountLinkTarget = {
  /** The `ExternalUser` row id. */
  identityId: string;
  externalUsername: string;
  kind: 'pending' | 'unverified';
};

/**
 * Show the one-time code that confirms a link, and wait for it to be posted
 * from the account (CHOO-3881).
 *
 * The server keeps no copy of a code, so there is no "show it again": every
 * code shown after the first is a new one, and asking for it retires the last.
 */
export const AccountLinkConfirmation = observer(function AccountLinkConfirmation({
  workspaceId,
  bridgeId,
  bridgeDisplayName,
  target,
  initialCode,
  onConfirmed,
  onCancelled,
}: {
  workspaceId: string;
  bridgeId: string;
  bridgeDisplayName: string;
  target: AccountLinkTarget;
  /** The code a claim came back with. Null asks for a fresh one on open. */
  initialCode: LinkCode | null;
  onConfirmed: (identity: LinkedIdentity) => void;
  /** After a pending link is cancelled. */
  onCancelled: () => void;
}) {
  const { setCloseGuard } = useModalContext();
  const serverId = workspacesStore.serverIdFor(workspaceId);
  const currentUserId = serverId
    ? (switchServersStore.statusFor(serverId)?.user?.id ?? null)
    : null;

  const [code, setCode] = useState<LinkCode | null>(initialCode);
  const [expiredCode, setExpiredCode] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = code !== null && expiredCode === code.code;

  const { identities, refresh } = useMyIdentities(
    workspaceId,
    code !== null && !expired ? LINK_CONFIRMATION_POLL_MS : false
  );
  const confirmed = identities?.find((i) => i.id === target.identityId && i.verified) ?? null;

  const issueCode = useCallback(async () => {
    setIssuing(true);
    setCloseGuard(true);
    setError(null);
    try {
      const result = await rpc.workspaces.issueIdentityLinkCode({
        workspaceId,
        bridgeId,
        identityId: target.identityId,
      });
      // Either way the lists may have moved: a new code changes when the
      // pending one expires, and a refusal may mean it was confirmed meanwhile.
      refresh();
      if (result.kind !== 'issued') {
        setError(issueFailureText(result));
        return;
      }
      setCode(result.code);
      setCopied(false);
    } catch (cause) {
      setError(failureText(cause, 'Could not get a new code.'));
    } finally {
      setIssuing(false);
      setCloseGuard(false);
    }
  }, [workspaceId, bridgeId, target.identityId, refresh, setCloseGuard]);

  // Once per mount: a second request would retire the code the first one is
  // about to show.
  const askedOnOpen = useRef(false);
  useEffect(() => {
    if (initialCode !== null || askedOnOpen.current) return;
    askedOnOpen.current = true;
    void issueCode();
  }, [initialCode, issueCode]);

  useEffect(() => {
    if (code === null) return;
    const timer = setTimeout(
      () => setExpiredCode(code.code),
      Math.max(0, Date.parse(code.expiresAt) - Date.now())
    );
    return () => clearTimeout(timer);
  }, [code]);

  // A code posted just before it expired is confirmed after the last poll.
  useEffect(() => {
    if (expired) refresh();
  }, [expired, refresh]);

  // Read through a ref so a caller's inline callback does not restart the hold
  // on every render.
  const onConfirmedRef = useRef(onConfirmed);
  useEffect(() => {
    onConfirmedRef.current = onConfirmed;
  });
  const reported = useRef(false);
  useEffect(() => {
    if (confirmed === null || reported.current) return;
    const timer = setTimeout(() => {
      reported.current = true;
      onConfirmedRef.current(confirmed);
    }, CONFIRMED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [confirmed]);

  const cancel = async () => {
    setCancelling(true);
    setCloseGuard(true);
    setError(null);
    try {
      await rpc.workspaces.releaseBridgeIdentity({
        workspaceId,
        bridgeId,
        identityId: target.identityId,
        userId: currentUserId,
      });
      refresh();
      onCancelled();
    } catch (cause) {
      setError(failureText(cause, 'Could not cancel this link.'));
    } finally {
      setCancelling(false);
      setCloseGuard(false);
    }
  };

  const copy = async () => {
    if (code === null) return;
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
    } catch {
      setError('Could not copy the code. Select it and copy it by hand.');
    }
  };

  const handle = accountHandle(target.externalUsername);

  if (confirmed !== null) {
    return (
      <p className="flex items-center gap-2 text-sm text-green-600 dark:text-green-500">
        <Check className="size-4 shrink-0" />
        {target.kind === 'pending' ? `Linked to ${handle}.` : `${handle} is confirmed.`}
      </p>
    );
  }

  const busy = issuing || cancelling;
  return (
    <div className="flex w-full flex-col gap-4" data-testid="account-link-confirmation">
      <p className="text-sm text-foreground">
        {target.kind === 'pending'
          ? `To finish linking ${handle}, post this code from that account in ${bridgeDisplayName}.`
          : `Confirm ${handle} is yours by posting this code from that account in ${bridgeDisplayName}. The link keeps working meanwhile.`}
      </p>

      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background-1 px-3 py-2.5">
        {code === null ? (
          <span className="flex items-center gap-2 text-sm text-foreground-muted">
            <Spinner className="size-3.5" />
            Getting a code…
          </span>
        ) : (
          <span
            data-testid="link-code"
            className={`font-mono text-xl tracking-widest select-all ${expired ? 'text-foreground-muted line-through' : 'text-foreground'}`}
          >
            {code.code}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={code === null || expired}
          onClick={() => void copy()}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      {code !== null && (
        <p className="text-xs text-foreground-muted">
          <InlineCode text={code.instructions} />
        </p>
      )}

      {code !== null &&
        (expired ? (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            This code has expired. Get a new one to{' '}
            {target.kind === 'pending' ? 'finish linking' : 'confirm the link'}.
          </p>
        ) : (
          <p className="flex items-center gap-2 text-xs text-foreground-muted">
            <Spinner className="size-3" />
            Waiting for the code. It expires at {expiryTime(code.expiresAt)}.
          </p>
        ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={expired ? 'default' : 'outline'}
          size="sm"
          disabled={busy}
          onClick={() => void issueCode()}
        >
          {issuing ? 'Getting a code…' : 'Get a new code'}
        </Button>
        {target.kind === 'pending' && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>
            {cancelling ? 'Cancelling…' : 'Cancel link'}
          </Button>
        )}
      </div>

      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
});

function expiryTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'soon' : format(date, 'HH:mm');
}

/** The server's instructions are a Markdown sentence whose only markup is
 * inline code — the command to post. Unbalanced backticks are shown as typed. */
function InlineCode({ text }: { text: string }) {
  const parts = text.split('`');
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="rounded bg-background-2 px-1 py-0.5 font-mono text-[11px] text-foreground"
          >
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  );
}

function issueFailureText(result: Exclude<IssueLinkCodeResult, { kind: 'issued' }>): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'refused':
      return result.message;
    case 'error':
      return result.message;
  }
}
