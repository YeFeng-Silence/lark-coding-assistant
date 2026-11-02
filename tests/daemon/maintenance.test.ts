import { describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { AssistantDaemon } from '../../src/daemon/server.js';
import { AppStore } from '../../src/core/store.js';
import { resolveAppPaths } from '../../src/core/paths.js';
import { launchMaintenance } from '../../src/update/manager.js';
vi.mock('../../src/update/manager.js', () => ({ launchMaintenance: vi.fn(), readUpdateStatus: vi.fn() }));
describe('Feishu maintenance commands', () => {
  it.each(['/update', '/restart'])('only accepts %s from the bound private owner', async (content) => {
    vi.mocked(launchMaintenance).mockReset();
    const paths = resolveAppPaths('/tmp/lca-maintenance-unit');
    const daemon = new AssistantDaemon(new AppStore(paths), paths);
    const internal = daemon as unknown as { state: unknown; gateway: unknown; onLarkMessage(message: NormalizedMessage): Promise<void> };
    const sendText = vi.fn(async () => undefined);
    internal.gateway = { sendText };
    internal.state = { schemaVersion: 2, ownerOpenId: 'owner', boundChatId: 'chat', sessions: {}, updatedAt: 1 };
    const message = { content, chatType: 'p2p', senderId: 'stranger', chatId: 'chat', senderType: 'user' } as NormalizedMessage;
    await internal.onLarkMessage(message);
    expect(launchMaintenance).not.toHaveBeenCalled();
    await internal.onLarkMessage({ ...message, senderId: 'owner' });
    expect(launchMaintenance).toHaveBeenCalledWith(paths, content.slice(1));
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});
