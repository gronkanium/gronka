import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  sendDMToUser,
  sendFollowUpMessage,
  notifyDownloadComplete,
  notifyDownloadFailed,
} from '../../src/utils/deferred-download-notifier.js';
import { isDiscordCdnUrl } from '../../src/utils/discord-cdn.js';

describe('deferred download notifier', () => {
  let mockClient;
  let mockUser;
  let mockMessage;
  let mockRest;

  beforeEach(() => {
    // Reset mocks before each test
    // Mock Discord.js Collection-like object with first() method
    const createMockCollection = () => {
      const map = new Map();
      const collection = {
        get size() {
          return map.size;
        },
        first: () => {
          if (map.size > 0) {
            return Array.from(map.values())[0];
          }
          return null;
        },
        set: (key, value) => {
          map.set(key, value);
        },
        get: key => map.get(key),
        has: key => map.has(key),
      };
      return collection;
    };

    mockMessage = {
      id: 'msg123',
      attachments: createMockCollection(),
    };

    mockUser = {
      send: async options => {
        if (options.files && options.files.length > 0) {
          // Simulate attachment
          const attachment = {
            url: 'https://cdn.discordapp.com/attachments/123/456/file.gif',
            name: 'file.gif',
          };
          mockMessage.attachments.set('0', attachment);
        }
        return mockMessage;
      },
    };

    mockRest = {
      post: async (_url, options) => {
        const response = {
          id: 'webhook-msg123',
          attachments: [],
        };
        if (options.body.files && options.body.files.length > 0) {
          response.attachments = [
            {
              url: 'https://cdn.discordapp.com/attachments/123/456/file.gif',
              name: 'file.gif',
            },
          ];
        }
        return response;
      },
    };

    mockClient = {
      users: {
        fetch: async _userId => {
          return mockUser;
        },
      },
      rest: mockRest,
      application: {
        id: 'app123',
      },
    };
  });

  describe('sendDMToUser', () => {
    test('sends DM to user successfully', async () => {
      const content = 'your download is ready';

      const message = await sendDMToUser(mockClient, 'user123', content);

      assert.ok(message);
      assert.strictEqual(message.id, 'msg123');
    });

    test('sends DM with attachment', async () => {
      const content = 'your download is ready';
      const mockAttachment = {
        name: 'file.gif',
        attachment: 'data',
      };

      const message = await sendDMToUser(mockClient, 'user123', content, mockAttachment);

      assert.ok(message);
      assert.ok(mockMessage.attachments.size > 0);
    });

    test('returns null when DM fails', async () => {
      mockUser.send = async () => {
        throw new Error('Cannot send messages to this user');
      };

      const userId = 'user123';
      const content = 'your download is ready';

      const message = await sendDMToUser(mockClient, userId, content);

      assert.strictEqual(message, null);
    });

    test('handles user fetch failure', async () => {
      mockClient.users.fetch = async _userId => {
        throw new Error('User not found');
      };

      const userId = 'user123';
      const content = 'your download is ready';

      const message = await sendDMToUser(mockClient, userId, content);

      assert.strictEqual(message, null);
    });
  });

  describe('sendFollowUpMessage', () => {
    test('sends follow-up message via webhook', async () => {
      const interactionToken = 'token123';
      const content = 'your download is ready';

      const response = await sendFollowUpMessage(mockClient, interactionToken, content);

      assert.ok(response);
      assert.strictEqual(response.id, 'webhook-msg123');
    });

    test('sends follow-up message with attachment', async () => {
      const interactionToken = 'token123';
      const content = 'your download is ready';
      const mockAttachment = {
        name: 'file.gif',
        attachment: 'data',
      };

      const response = await sendFollowUpMessage(
        mockClient,
        interactionToken,
        content,
        mockAttachment
      );

      assert.ok(response);
      assert.ok(response.attachments.length > 0);
    });

    test('returns null when follow-up fails', async () => {
      mockRest.post = async () => {
        throw new Error('Webhook expired');
      };

      const interactionToken = 'token123';
      const content = 'your download is ready';

      const response = await sendFollowUpMessage(mockClient, interactionToken, content);

      assert.strictEqual(response, null);
    });
  });

  describe('notifyDownloadComplete', () => {
    test('sends DM with result message', async () => {
      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const result = 'https://example.com/file.gif';

      const discordUrl = await notifyDownloadComplete(mockClient, queueItem, result);

      // Should return null when result is a URL (not attachment)
      assert.strictEqual(discordUrl, null);
    });

    test('sends DM with attachment and extracts URL', async () => {
      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const mockAttachment = {
        name: 'file.gif',
        attachment: 'data',
      };

      // The mockUser.send will automatically add attachment when files are provided
      // So we don't need to manually set it here - it's handled in beforeEach

      const discordUrl = await notifyDownloadComplete(mockClient, queueItem, null, mockAttachment);

      assert.strictEqual(discordUrl, 'https://cdn.discordapp.com/attachments/123/456/file.gif');
    });

    test('falls back to follow-up when DM fails', async () => {
      mockUser.send = async () => {
        throw new Error('Cannot send messages to this user');
      };

      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const result = 'https://example.com/file.gif';

      // Mock follow-up response without attachment (since no attachment was passed)
      mockRest.post = async (_url, _options) => {
        return {
          id: 'webhook-msg123',
          attachments: [],
        };
      };

      const discordUrl = await notifyDownloadComplete(mockClient, queueItem, result);

      // Should try follow-up but no attachment was sent, so discordUrl should be null
      assert.strictEqual(discordUrl, null);
    });

    test('falls back to follow-up with attachment', async () => {
      mockUser.send = async () => {
        throw new Error('Cannot send messages to this user');
      };

      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const mockAttachment = {
        name: 'file.gif',
        attachment: 'data',
      };

      // Mock follow-up response with attachment
      mockRest.post = async (_url, _options) => {
        return {
          id: 'webhook-msg123',
          attachments: [
            {
              url: 'https://cdn.discordapp.com/attachments/123/456/file.gif',
              name: 'file.gif',
            },
          ],
        };
      };

      const discordUrl = await notifyDownloadComplete(mockClient, queueItem, null, mockAttachment);

      assert.strictEqual(discordUrl, 'https://cdn.discordapp.com/attachments/123/456/file.gif');
    });

    test('handles operationId and userId parameters', async () => {
      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const result = 'https://example.com/file.gif';

      const discordUrl = await notifyDownloadComplete(
        mockClient,
        queueItem,
        result,
        null,
        'op123',
        'user123'
      );

      assert.strictEqual(discordUrl, null);
    });

    test('returns null when both DM and follow-up fail', async () => {
      mockUser.send = async () => {
        throw new Error('Cannot send messages to this user');
      };
      mockRest.post = async () => {
        throw new Error('Webhook expired');
      };

      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const result = 'https://example.com/file.gif';

      const discordUrl = await notifyDownloadComplete(mockClient, queueItem, result);

      assert.strictEqual(discordUrl, null);
    });
  });

  describe('notifyDownloadFailed', () => {
    test('sends DM with error message', async () => {
      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const errorMessage = 'Download failed: Network error';

      await notifyDownloadFailed(mockClient, queueItem, errorMessage);

      // Should complete without error
      assert.ok(true);
    });

    test('sends DM with operationId and userId', async () => {
      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const errorMessage = 'Download failed';

      await notifyDownloadFailed(mockClient, queueItem, errorMessage, 'op123', 'user123');

      // Should complete without error
      assert.ok(true);
    });

    test('falls back to follow-up when DM fails', async () => {
      mockUser.send = async () => {
        throw new Error('Cannot send messages to this user');
      };

      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const errorMessage = 'Download failed: Network error';

      await notifyDownloadFailed(mockClient, queueItem, errorMessage);

      // Should complete without error (follow-up attempted)
      assert.ok(true);
    });

    test('handles both DM and follow-up failure gracefully', async () => {
      mockUser.send = async () => {
        throw new Error('Cannot send messages to this user');
      };
      mockRest.post = async () => {
        throw new Error('Webhook expired');
      };

      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const errorMessage = 'Download failed';

      // Should not throw even if both fail
      await assert.doesNotReject(notifyDownloadFailed(mockClient, queueItem, errorMessage));
    });
  });

  describe('attachment URL extraction', () => {
    test('extracts attachment URL from DM message', async () => {
      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const mockAttachment = {
        name: 'file.gif',
        attachment: 'data',
      };

      // The mockUser.send will automatically add attachment when files are provided
      // So we don't need to manually set it here - it's handled in beforeEach

      const discordUrl = await notifyDownloadComplete(mockClient, queueItem, null, mockAttachment);

      assert.ok(discordUrl);
      assert.ok(isDiscordCdnUrl(discordUrl));
    });

    test('extracts attachment URL from follow-up response', async () => {
      mockUser.send = async () => {
        throw new Error('Cannot send messages to this user');
      };

      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const mockAttachment = {
        name: 'file.gif',
        attachment: 'data',
      };

      // Mock follow-up response
      mockRest.post = async (_url, _options) => {
        return {
          id: 'webhook-msg123',
          attachments: [
            {
              url: 'https://cdn.discordapp.com/attachments/789/012/file.gif',
              name: 'file.gif',
            },
          ],
        };
      };

      const discordUrl = await notifyDownloadComplete(mockClient, queueItem, null, mockAttachment);

      assert.strictEqual(discordUrl, 'https://cdn.discordapp.com/attachments/789/012/file.gif');
    });

    test('returns null when no attachment URL available', async () => {
      const queueItem = {
        userId: 'user123',
        username: 'TestUser',
        interactionToken: 'token123',
      };
      const result = 'https://example.com/file.gif';

      const discordUrl = await notifyDownloadComplete(mockClient, queueItem, result);

      assert.strictEqual(discordUrl, null);
    });
  });
});
