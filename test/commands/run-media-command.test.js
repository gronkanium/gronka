import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runMediaCommand } from '../../src/commands/shared/run-media-command.js';
import { ValidationError, NetworkError } from '../../src/utils/errors.js';
import { safeInteractionEditReply } from '../../src/utils/interaction-helpers.js';
import { createFakeInteraction } from '../helpers/fake-interaction.js';

// In-process E2E for the shared command lifecycle: drives runMediaCommand with a fake Discord
// interaction and asserts exactly what the user would see. Covers the Discord reply paths that
// the pure unit tests cannot reach (and where the earlier AI-generated wrapper introduced
// double-reply / raw-leak bugs).
describe('runMediaCommand (Discord lifecycle E2E)', () => {
  test('success: the callback reply is sent once and the wrapper does NOT reply again', async () => {
    const { interaction, calls } = createFakeInteraction();

    await runMediaCommand(
      'optimize',
      interaction,
      async () => {
        // A command's success path replies itself; the wrapper must not reply again.
        await safeInteractionEditReply(interaction, {
          content: 'https://cdn.example.com/gifs/abc.gif',
        });
      },
      { skipDbInit: true }
    );

    assert.strictEqual(calls.editReply.length, 1, 'exactly one reply — no double reply');
    assert.strictEqual(calls.editReply[0].content, 'https://cdn.example.com/gifs/abc.gif');
  });

  test('success with an attachment: wrapper leaves the attachment reply untouched', async () => {
    const { interaction, calls } = createFakeInteraction();

    await runMediaCommand(
      'download',
      interaction,
      async () => {
        await safeInteractionEditReply(interaction, {
          files: [{ name: 'abc.mp4' }],
        });
      },
      { skipDbInit: true }
    );

    assert.strictEqual(calls.editReply.length, 1);
    assert.ok(calls.editReply[0].files, 'attachment reply preserved');
    assert.strictEqual(calls.editReply[0].content, undefined, 'no extra URL content clobbering it');
  });

  test('AppError: the curated, user-facing message is shown', async () => {
    const { interaction, calls } = createFakeInteraction();

    await runMediaCommand(
      'optimize',
      interaction,
      async () => {
        throw new ValidationError('file too large. maximum size for gif files is 50mb.');
      },
      { skipDbInit: true }
    );

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
      { skipDbInit: true, errorFallback: 'could not download this content.' }
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
      { skipDbInit: true, errorFallback: fallback }
    );

    assert.strictEqual(calls.editReply.length, 1);
    assert.strictEqual(calls.editReply[0].content, fallback);
    assert.ok(
      !calls.editReply[0].content.includes('undefined'),
      'raw internal error text must not reach the user'
    );
  });

  test('temp files registered on ctx are cleaned up on success', async () => {
    const { interaction } = createFakeInteraction();
    const tmpFile = path.join(os.tmpdir(), `rmc-e2e-ok-${Date.now()}.tmp`);
    await fs.writeFile(tmpFile, 'data');

    await runMediaCommand(
      'convert',
      interaction,
      async ctx => {
        ctx.tempFiles.push(tmpFile);
        await safeInteractionEditReply(interaction, { content: 'ok' });
      },
      { skipDbInit: true }
    );

    await assert.rejects(() => fs.access(tmpFile), 'temp file should be deleted after success');
  });

  test('temp files are cleaned up even when the callback throws', async () => {
    const { interaction } = createFakeInteraction();
    const tmpFile = path.join(os.tmpdir(), `rmc-e2e-err-${Date.now()}.tmp`);
    await fs.writeFile(tmpFile, 'data');

    await runMediaCommand(
      'convert',
      interaction,
      async ctx => {
        ctx.tempFiles.push(tmpFile);
        throw new ValidationError('boom');
      },
      { skipDbInit: true }
    );

    await assert.rejects(() => fs.access(tmpFile), 'temp file should be deleted on error too');
  });

  test('ctx exposes the expected helpers to the callback', async () => {
    const { interaction } = createFakeInteraction();
    let seen = null;

    await runMediaCommand(
      'optimize',
      interaction,
      async ctx => {
        seen = {
          hasOperationId: typeof ctx.operationId === 'string' && ctx.operationId.length > 0,
          userId: ctx.userId,
          adminUser: ctx.adminUser,
          isTempArray: Array.isArray(ctx.tempFiles),
          logStepFn: typeof ctx.logStep === 'function',
          buildMetadataFn: typeof ctx.buildMetadata === 'function',
        };
      },
      { skipDbInit: true }
    );

    assert.ok(seen.hasOperationId);
    assert.strictEqual(seen.userId, 'e2e-user');
    assert.strictEqual(seen.adminUser, false);
    assert.ok(seen.isTempArray);
    assert.ok(seen.logStepFn);
    assert.ok(seen.buildMetadataFn);
  });
});
