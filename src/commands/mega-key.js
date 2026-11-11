import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { parseMegaUrl } from '../utils/mega.js';
import { safeInteractionReply, safeInteractionDeferReply } from '../utils/interaction-helpers.js';
import { refuse } from './shared/command-guards.js';

const PREFIX = 'megakey:';

// Everything the submit needs rides in the custom id, so there is no session to expire.
export async function promptForMegaKey(interaction, fileId, commandSource, startTime, duration) {
  // A modal can only be the first response, so a link that was deferred to resolve asks again.
  if (interaction.deferred) {
    await refuse(interaction, 'download', {
      message: 'send the full mega link including the key (the part after #).',
      reason: 'missing_input',
      context: { originalUrl: `https://mega.nz/file/${fileId}`, commandSource },
    });
    return;
  }
  const source = commandSource === 'context-menu' ? 'c' : 's';
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}${fileId}:${source}:${startTime ?? ''}:${duration ?? ''}`)
    .setTitle('Mega decryption key');
  const keyInput = new TextInputBuilder()
    .setCustomId('mega_key')
    .setPlaceholder('the part after # in the full link')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(200);
  modal.addLabelComponents(
    new LabelBuilder().setLabel('Decryption key for this file').setTextInputComponent(keyInput)
  );
  await interaction.showModal(modal);
}

export async function handleMegaKeyInteraction(interaction, processDownload) {
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith(PREFIX)) return false;
  const [fileId, source, start, duration] = interaction.customId.slice(PREFIX.length).split(':');
  const key = interaction.fields.getTextInputValue('mega_key').match(/[\w-]{43}/)?.[0];
  const url = `https://mega.nz/file/${fileId}#${key}`;
  if (!key || !parseMegaUrl(url)) {
    await safeInteractionReply(interaction, {
      content: 'that does not look like a mega key. it is the 43 characters after # in the link.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  await safeInteractionDeferReply(interaction);
  await processDownload(
    interaction,
    url,
    source === 'c' ? 'context-menu' : 'slash',
    start === '' ? null : Number(start),
    duration === '' ? null : Number(duration)
  );
  return true;
}
