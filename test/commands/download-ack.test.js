import { test, describe, spyOn } from 'bun:test';
import assert from 'node:assert';
import axios from 'axios';
import { MessageFlags } from 'discord.js';
import { createFakeInteraction } from '../helpers/fake-interaction.js';
import {
  handleDownloadCommand,
  handleDownloadContextMenuCommand,
} from '../../src/commands/download.js';

const UNSUPPORTED =
  'url is not from a supported social media platform. supported sites are listed on <https://gronka.dev/#sites>.';

function slash(url) {
  const fake = createFakeInteraction({ deferred: false });
  fake.interaction.options = {
    getString: name => (name === 'link' ? url : null),
    getBoolean: () => null,
    getNumber: () => null,
  };
  return fake;
}

function contextMenu(url) {
  const fake = createFakeInteraction({ deferred: false });
  Object.assign(fake.interaction, {
    commandName: 'download',
    isMessageContextMenuCommand: () => true,
    targetMessage: { content: `look ${url}` },
  });
  return fake;
}

const entries = [
  ['/download', slash, handleDownloadCommand],
  ['the download context menu', contextMenu, handleDownloadContextMenuCommand],
];

// A short link that redirects to target, slowly, noting whether Discord was answered first.
async function resolvingTo(target, run) {
  const deferredAtResolve = [];
  const spy = spyOn(axios, 'get').mockImplementation(async () => {
    deferredAtResolve.push(run.interaction.deferred);
    await Bun.sleep(50);
    return { data: { destroy() {} }, request: { res: { responseUrl: target } } };
  });
  try {
    await run.handler(run.interaction);
  } finally {
    spy.mockRestore();
  }
  return deferredAtResolve;
}

describe('download acknowledges Discord before any network work', () => {
  for (const [name, make, handler] of entries) {
    test(`${name}: a short link is deferred before it is resolved`, async () => {
      const { interaction, calls } = make('https://vm.tiktok.com/ZSack1/');
      const deferredAtResolve = await resolvingTo('https://example.com/page', {
        interaction,
        handler,
      });
      assert.deepStrictEqual(deferredAtResolve, [true]);
      assert.strictEqual(calls.reply.length, 0);
      assert.strictEqual(calls.editReply.at(-1).content, UNSUPPORTED);
    });

    test(`${name}: a link that needs no lookup is still refused privately`, async () => {
      const { interaction, calls } = make('https://example.com/page');
      const spy = spyOn(axios, 'get');
      try {
        await handler(interaction);
        assert.strictEqual(spy.mock.calls.length, 0);
      } finally {
        spy.mockRestore();
      }
      assert.strictEqual(calls.deferReply.length, 0);
      assert.deepStrictEqual(calls.reply, [
        { content: UNSUPPORTED, flags: MessageFlags.Ephemeral },
      ]);
    });

    test(`${name}: a short link to a keyless mega file asks for the full link`, async () => {
      const { interaction, calls } = make('https://vm.tiktok.com/ZSack2/');
      let modals = 0;
      interaction.showModal = async () => modals++;
      await resolvingTo('https://mega.nz/file/AbCdEfGh', { interaction, handler });
      assert.strictEqual(modals, 0);
      assert.match(calls.editReply.at(-1).content, /full mega link/);
    });
  }
});
