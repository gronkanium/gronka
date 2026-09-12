import {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { randomBytes } from 'crypto';
import { discoverMangaDexTitle } from '../utils/gallery-dl.js';
import {
  safeInteractionReply,
  safeInteractionDeferReply,
  safeInteractionEditReply,
} from '../utils/interaction-helpers.js';

const sessions = new Map();
const SESSION_TTL = 10 * 60 * 1000;
const MAX_OPTIONS = 25;

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) sessions.delete(token);
  }
}, 60 * 1000).unref?.();

function token() {
  return randomBytes(6).toString('hex');
}

function chapterLabel(chapter) {
  const metadata = chapter.metadata;
  const number = metadata.chapter ?? (metadata.gallery_id ? 'Gallery' : '?');
  const minor = metadata.chapter_minor || '';
  const language = (metadata.lang || 'unknown').toUpperCase();
  const group = metadata.group?.join(', ') || metadata.user?.join(', ') || 'uncredited';
  return `Ch. ${number}${minor} • ${language} • ${group}`.slice(0, 100);
}

function chapterDescription(chapter) {
  const metadata = chapter.metadata;
  return `${chapter.urls.length} pages${metadata.title ? ` • ${metadata.title}` : ''}`.slice(
    0,
    100
  );
}

export function isMangaInteraction(interaction) {
  return (
    (interaction.isMessageComponent() || interaction.isModalSubmit()) &&
    interaction.customId.startsWith('manga:')
  );
}

export async function beginMangaSelection(interaction, url) {
  await safeInteractionDeferReply(interaction, { flags: MessageFlags.Ephemeral });
  const manga = await discoverMangaDexTitle(url);
  if (manga.chapters.length === 0) {
    await safeInteractionEditReply(interaction, {
      content: 'no downloadable chapters were found for this MangaDex title.',
    });
    return;
  }
  const sessionToken = token();
  sessions.set(sessionToken, {
    createdAt: Date.now(),
    userId: interaction.user.id,
    sourceUrl: url,
    title: manga.title,
    chapters: manga.chapters,
  });
  const options = manga.chapters.slice(0, MAX_OPTIONS).map((chapter, index) => ({
    label: chapterLabel(chapter),
    description: chapterDescription(chapter),
    value: String(index),
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`manga:chapter:${sessionToken}`)
    .setPlaceholder('choose a chapter and source')
    .addOptions(options);
  const suffix =
    manga.chapters.length > MAX_OPTIONS
      ? `\nShowing the first ${MAX_OPTIONS} available chapter/source entries.`
      : '';
  await safeInteractionEditReply(interaction, {
    embeds: [
      new EmbedBuilder()
        .setTitle(manga.title)
        .setDescription(
          `Choose a chapter to download. Up to 10 pages are sent as images; larger selections are sent as a ZIP. The next step lets you choose the page range.${suffix}`
        ),
    ],
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

export async function handleMangaInteraction(interaction, processDownload) {
  if (!isMangaInteraction(interaction)) return false;
  const [, action, sessionToken] = interaction.customId.split(':');
  const session = sessions.get(sessionToken);
  if (!session || session.userId !== interaction.user.id) {
    await safeInteractionReply(interaction, {
      content: 'this manga picker has expired. run `/download` again.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  if (action === 'chapter' && interaction.isStringSelectMenu()) {
    const index = Number(interaction.values[0]);
    const chapter = session.chapters[index];
    if (!chapter) {
      await safeInteractionReply(interaction, {
        content: 'that chapter selection is invalid.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    session.chapter = chapter;
    const modal = new ModalBuilder()
      .setCustomId(`manga:pages:${sessionToken}`)
      .setTitle('Choose manga pages');
    const pageRange = new TextInputBuilder()
      .setCustomId('page_range')
      .setLabel('Pages (1-10 are images; 11+ becomes a ZIP)')
      .setPlaceholder(`1-${Math.min(10, chapter.urls.length)}, or one page number`)
      .setValue(`1-${Math.min(10, chapter.urls.length)}`)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(20);
    modal.addComponents(new ActionRowBuilder().addComponents(pageRange));
    await interaction.showModal(modal);
    return true;
  }
  if (action === 'pages' && interaction.isModalSubmit()) {
    const chapter = session.chapter;
    if (!chapter) {
      await safeInteractionReply(interaction, {
        content: 'that manga selection is invalid. run `/download` again.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const value = interaction.fields.getTextInputValue('page_range').trim();
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(value);
    const start = match ? Number(match[1]) : NaN;
    const end = match?.[2] ? Number(match[2]) : start;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      end > chapter.urls.length
    ) {
      await safeInteractionReply(interaction, {
        content: `enter a valid page range from 1 to ${chapter.urls.length}.`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    sessions.delete(sessionToken);
    await safeInteractionDeferReply(interaction, { flags: MessageFlags.Ephemeral });
    const downloadUrl = chapter.metadata.chapter_id
      ? `https://mangadex.org/chapter/${chapter.metadata.chapter_id}`
      : session.sourceUrl;
    await processDownload(interaction, downloadUrl, 'slash', null, null, {
      mediaUrls: chapter.urls.slice(start - 1, end),
    });
    return true;
  }
  await safeInteractionReply(interaction, {
    content: 'that manga control is no longer valid. run `/download` again.',
    flags: MessageFlags.Ephemeral,
  });
  return true;
}
