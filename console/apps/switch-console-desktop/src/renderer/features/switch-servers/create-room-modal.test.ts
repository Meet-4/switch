import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CreateRoomModal } from './CreateRoomModal';

const flags = vi.hoisted(() => ({ group_chats: true }));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({ useFeatureFlags: () => flags }));
vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
vi.mock('@renderer/features/chats/stores/chats', () => ({ chatsStore: {} }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

// The dialog's frame needs an open dialog around it; its contents are the subject here.
vi.mock('@renderer/lib/ui/dialog', () => {
  const pass = ({ children }: { children?: unknown }) => children;
  return {
    DialogContentArea: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
  };
});

describe('CreateRoomModal', () => {
  it('labels its fields as the other forms do: Name, then Participants', () => {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(CreateRoomModal, { onSuccess: () => {}, onClose: () => {} })
      )
    );
    expect(html).toMatch(/<label[^>]*for="new-room-name"[^>]*>Name<\/label>/);
    expect(html).toContain('placeholder="Name this room"');
    expect(html).toMatch(/<label[^>]*for="new-room-participants"[^>]*>Participants<\/label>/);
    expect(html).not.toContain('uppercase');
    expect(html).not.toContain('can’t create rooms yet');
  });

  it('explains, instead of the form, that no room can be created without group chats or a messaging app', () => {
    flags.group_chats = false;
    try {
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(CreateRoomModal, { onSuccess: () => {}, onClose: () => {} })
        )
      );
      expect(html).toContain('This server can’t create rooms yet.');
      expect(html).toContain('start a 1-1 chat from an agent’s page');
      expect(html).toContain('>Close</button>');
      expect(html).not.toContain('new-room-name');
      expect(html).not.toContain('Create room');
    } finally {
      flags.group_chats = true;
    }
  });
});
