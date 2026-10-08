import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
import { setTimeout as delay } from 'node:timers/promises';
import { OUTPUT_FORMATS } from '../utils/output-formats.js';
import { jobSignal } from '../utils/media-file.js';
import {
  getConvertPicker,
  publishConvertPicker,
  chooseConvertFormat,
  cancelConvertPicker,
  WORKER_ID,
} from '../utils/database/media-jobs-pg.js';
import {
  safeInteractionReply,
  safeInteractionEditReply,
  safeInteractionDeferReply,
} from '../utils/interaction-helpers.js';
import { interactionFor, prepareReplyTarget } from '../jobs/reply-target.js';
import { curatedErrorMessage } from './shared/command-errors.js';
import { refuse } from './shared/command-guards.js';

export const CONVERT_PICKER_TTL_MS = 5 * 60 * 1000;
const expired = 'this convert picker has expired. run convert again.';

export async function waitForConvertFormat(interaction, jobId, picker, formats, info) {
  let job = await getConvertPicker(jobId, picker.token);
  if (!job || job.worker !== WORKER_ID) return null;
  const expiresAt =
    picker.expiresAt ?? Math.min(Date.now() + CONVERT_PICKER_TTL_MS, job.reply.expiresAt - 30000);
  if (!job.args.format && !job.args.picker.cancelled && expiresAt > Date.now()) {
    const published = await publishConvertPicker(jobId, picker.token, formats, expiresAt);
    if (published) {
      const options = formats.map(format => ({
        value: format,
        label: format === 'gif' ? 'GIF' : OUTPUT_FORMATS[format].label,
        ...(format === 'gif' && info.kind === 'video'
          ? { description: 'animation without sound' }
          : OUTPUT_FORMATS[format]?.kind === 'image' && info.kind !== 'image'
            ? { description: 'a still frame from the selected start time' }
            : {}),
      }));
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`convert:format:${jobId}:${picker.token}`)
        .setPlaceholder('convert to…')
        .addOptions(options);
      const cancel = new ButtonBuilder()
        .setCustomId(`convert:cancel:${jobId}:${picker.token}`)
        .setLabel('cancel')
        .setStyle(ButtonStyle.Secondary);
      const shown = await safeInteractionEditReply(interaction, {
        content: `choose an output format for \`${(info.filename ?? 'this file').replace(/[`\r\n]/g, '').slice(0, 160)}\`. this picker expires in ${Math.max(1, Math.ceil((expiresAt - Date.now()) / 60000))} minutes.`,
        allowedMentions: { parse: [] },
        components: [
          new ActionRowBuilder().addComponents(menu),
          new ActionRowBuilder().addComponents(cancel),
        ],
      });
      if (!shown) return null;
    }
  }
  while (true) {
    job = await getConvertPicker(jobId, picker.token);
    if (!job || job.worker !== WORKER_ID) return null;
    if (job.args.format) {
      await safeInteractionEditReply(interaction, {
        content: `selected ${job.args.format}. the converted file will be posted to chat.`,
        components: [],
      });
      return {
        format: job.args.format,
        interaction: await interactionFor(interaction.client, job),
      };
    }
    if (job.args.picker.cancelled || Date.now() >= (job.args.picker.expiresAt ?? expiresAt)) {
      await safeInteractionEditReply(interaction, {
        content: job.args.picker.cancelled ? 'conversion cancelled.' : expired,
        components: [],
      });
      return null;
    }
    await delay(500, undefined, { signal: jobSignal() });
  }
}

export async function handleConvertInteraction(interaction) {
  const match = /^convert:(format|cancel):(\d+):([a-f0-9]{24})$/.exec(interaction.customId ?? '');
  if (!match) return false;
  const [, action, jobId, token] = match;
  const reply = content =>
    safeInteractionReply(interaction, { content, flags: MessageFlags.Ephemeral });
  let job;
  try {
    job = await getConvertPicker(jobId, token);
    if (!job || job.args.picker.cancelled || Date.now() >= job.args.picker.expiresAt) {
      await reply(expired);
      return true;
    }
    if (job.reply.kind === 'message') {
      const original = await interaction.channel?.messages
        .fetch(job.reply.messageId)
        .catch(() => null);
      if (!original || original.author?.id !== interaction.user.id) {
        await reply('only the person who ran convert can use this picker.');
        return true;
      }
    } else if (!interaction.message?.flags?.has(MessageFlags.Ephemeral)) {
      await reply('run convert again to open your own picker.');
      return true;
    }
    if (job.args.format) {
      await reply('a format has already been selected.');
      return true;
    }
    if (action === 'cancel' && interaction.isButton()) {
      await interaction.deferUpdate();
      await cancelConvertPicker(jobId, token);
      return true;
    }
    const format = interaction.values?.[0];
    if (
      action !== 'format' ||
      !interaction.isStringSelectMenu() ||
      !job.args.picker.formats?.includes(format)
    ) {
      await reply('that output format is not available for this file.');
      return true;
    }
    if (!(await safeInteractionDeferReply(interaction))) return true;
    const chosen = await chooseConvertFormat(
      jobId,
      token,
      format,
      await prepareReplyTarget(interaction)
    );
    if (!chosen)
      await safeInteractionEditReply(interaction, {
        content: 'this selection was already handled or expired.',
      });
  } catch (error) {
    await refuse(interaction, 'convert', {
      message: curatedErrorMessage(error, 'could not select that format. please try again.'),
      cause: error,
      reason: 'conversion_picker_failed',
      context: {
        originalUrl: job?.args.url ?? job?.args.attachment?.url,
        commandOptions: { format: interaction.values?.[0] },
      },
    });
  }
  return true;
}
