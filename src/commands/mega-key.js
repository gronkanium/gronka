import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { parseMegaUrl } from '../utils/mega.js';
import { safeInteractionReply, safeInteractionDeferReply } from '../utils/interaction-helpers.js';

const PREFIX = 'megakey:';

// Everything the submit needs rides in the custom id, so there is no session to expire.
export async function promptForMegaKey(
  interaction,
  fileId,
  commandSource,
  startTime,
  duration,
  audioOnly = false
) {
  const source = commandSource === 'context-menu' ? 'c' : 's';
  const modal = new ModalBuilder()
    .setCustomId(
      `${PREFIX}${fileId}:${source}:${startTime ?? ''}:${duration ?? ''}:${audioOnly ? 1 : ''}`
    )
    .setTitle('Mega decryption key');
  const keyInput = new TextInputBuilder()
    .setCustomId('mega_key')
    .setLabel('Decryption key for this file')
    .setPlaceholder('the part after # in the full link')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(200);
  modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
  await interaction.showModal(modal);
}

export async function handleMegaKeyInteraction(interaction, processDownload) {
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith(PREFIX)) return false;
  const [fileId, source, start, duration, audio] = interaction.customId
    .slice(PREFIX.length)
    .split(':');
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
    duration === '' ? null : Number(duration),
    { audioOnly: audio === '1' }
  );
  return true;
}
