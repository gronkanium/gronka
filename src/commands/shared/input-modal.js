import {
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { firstUrlIn } from '../../utils/validation.js';

const PREFIX = 'input:';

// The command's other options ride in the custom id, so a submit has no session to expire.
export function askForInput(interaction, command, { label, fileTypes }, options) {
  const upload = new FileUploadBuilder()
    .setCustomId('file')
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1)
    .setFileTypes(fileTypes);
  const link = new TextInputBuilder()
    .setCustomId('link')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder('https://');
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}${command}:${options.join(':')}`)
    .setTitle(command)
    .addLabelComponents(
      new LabelBuilder().setLabel(label).setFileUploadComponent(upload),
      new LabelBuilder().setLabel('or paste a link').setTextInputComponent(link)
    );
  return interaction.showModal(modal);
}

export function readInputModal(interaction) {
  if (!interaction.customId?.startsWith(PREFIX)) return null;
  const [command, ...options] = interaction.customId.slice(PREFIX.length).split(':');
  const { fields } = interaction.fields;
  const attachment = fields.get('file')?.attachments?.first() ?? null;
  const text = fields.get('link')?.value?.trim();
  const url = attachment || !text ? null : (firstUrlIn(text) ?? text);
  return { command, options, attachment, url };
}
