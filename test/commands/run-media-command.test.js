import { test, describe } from 'bun:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import { runMediaCommand } from '../../src/commands/shared/run-media-command.js';
import { ValidationError, NetworkError } from '../../src/utils/errors.js';
import { safeInteractionEditReply } from '../../src/utils/interaction-helpers.js';
import { createFakeInteraction } from '../helpers/fake-interaction.js';
import { getOperation, updateOperationStatus } from '../../src/utils/operations-tracker.js';
import { tempPath } from '../../src/utils/media-file.js';

// In-process E2E for the shared command lifecycle: drives runMediaCommand with a fake Discord
// interaction and asserts exactly what the user would see. Covers the Discord reply paths that
// the pure unit tests cannot reach (and where the earlier AI-generated wrapper introduced
// double-reply / raw-leak bugs).
describe('runMediaCommand (Discord lifecycle E2E)', () => {
  test('success: the callback reply is sent once and the wrapper does NOT reply again', async () => {
    const { interaction, calls } = createFakeInteraction();

    await runMediaCommand('optimize', interaction, async () => {
      // A command's success path replies itself; the wrapper must not reply again.
      await safeInteractionEditReply(interaction, {
        content: 'https://cdn.example.com/gifs/abc.gif',
      });
    });

    assert.strictEqual(calls.editReply.length, 1, 'exactly one reply, no double reply');
    assert.strictEqual(calls.editReply[0].content, 'https://cdn.example.com/gifs/abc.gif');
  });

  test('success with an attachment: wrapper leaves the attachment reply untouched', async () => {
    const { interaction, calls } = createFakeInteraction();

    await runMediaCommand('download', interaction, async () => {
      await safeInteractionEditReply(interaction, {
        files: [{ name: 'abc.mp4' }],
      });
    });

    assert.strictEqual(calls.editReply.length, 1);
    assert.ok(calls.editReply[0].files, 'attachment reply preserved');
    assert.strictEqual(calls.editReply[0].content, undefined, 'no extra URL content clobbering it');
  });

  test('AppError: the curated, user-facing message is shown', async () => {
    const { interaction, calls } = createFakeInteraction();

    await runMediaCommand('optimize', interaction, async () => {
      throw new ValidationError('file too large. maximum size for gif files is 50mb.');
    });

    assert.strictEqual(calls.editReply.length, 1);
    assert.strictEqual(
      calls.editReply[0].content,
      'file too large. maximum size for gif files is 50mb.'
    );
  });

  test('curated NetworkError (e.g. deleted post) is shown verbatim', async () => {
    const { interaction, calls } = createFakeInteraction();

    await runMediaCommand(
      'download',
      interaction,
      async () => {
        throw new NetworkError('this post is unavailable or has been deleted');
      },
      { errorFallback: 'could not download this content.' }
    );

    assert.strictEqual(calls.editReply[0].content, 'this post is unavailable or has been deleted');
  });

  test('unexpected Error: the generic fallback is shown and the raw message never leaks', async () => {
    const { interaction, calls } = createFakeInteraction();
    const fallback = 'could not download this content. it may be deleted, private, or unsupported.';

    await runMediaCommand(
      'download',
      interaction,
      async () => {
        throw new Error('Cannot read properties of undefined (reading "buffer")');
      },
      { errorFallback: fallback }
    );

    assert.strictEqual(calls.editReply.length, 1);
    assert.strictEqual(calls.editReply[0].content, fallback);
    assert.ok(
      !calls.editReply[0].content.includes('undefined'),
      'raw internal error text must not reach the user'
    );
  });

  test('files made in the job dir are removed on success', async () => {
    const { interaction } = createFakeInteraction();
    let tmpFile;
    await runMediaCommand('convert', interaction, async () => {
      tmpFile = await tempPath('.tmp');
      await fs.writeFile(tmpFile, 'data');
      await safeInteractionEditReply(interaction, { content: 'ok' });
    });
    await assert.rejects(() => fs.access(tmpFile), 'job file should be deleted after success');
  });

  test('files made in the job dir are removed when the callback throws', async () => {
    const { interaction } = createFakeInteraction();
    let tmpFile;
    await runMediaCommand('convert', interaction, async () => {
      tmpFile = await tempPath('.tmp');
      await fs.writeFile(tmpFile, 'data');
      throw new ValidationError('boom');
    });
    await assert.rejects(() => fs.access(tmpFile), 'job file should be deleted on error too');
  });

  test('a callback that returns without marking the operation does not leave it running', async () => {
    const { interaction } = createFakeInteraction();
    let capturedId;

    await runMediaCommand('convert', interaction, async ctx => {
      capturedId = ctx.operationId;
      // mirrors convert.js's "video is too long" path: replies, returns, marks nothing
      await safeInteractionEditReply(interaction, { content: 'video is too long (45s).' });
    });

    assert.strictEqual(getOperation(capturedId).status, 'error');
  });

  test('a callback that marks success keeps that status', async () => {
    const { interaction } = createFakeInteraction();
    let capturedId;

    await runMediaCommand('convert', interaction, async ctx => {
      capturedId = ctx.operationId;
      updateOperationStatus(ctx.operationId, 'success', { fileSize: 1 });
    });

    assert.strictEqual(getOperation(capturedId).status, 'success');
  });

  test('ctx exposes the operation and its step logger, and nothing about the user', async () => {
    const { interaction } = createFakeInteraction();
    let seen = null;

    await runMediaCommand('optimize', interaction, async ctx => {
      seen = ctx;
    });

    assert.ok(typeof seen.operationId === 'string' && seen.operationId.length > 0);
    assert.strictEqual(typeof seen.logStep, 'function');
    assert.ok(!('userId' in seen) && !('adminUser' in seen) && !('buildMetadata' in seen));
  });
});
