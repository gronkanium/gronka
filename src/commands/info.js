import { EmbedBuilder, MessageFlags, version as discordVersion } from 'discord.js';
import os from 'node:os';
import pkg from '../../package.json' with { type: 'json' };
import { createLogger } from '../utils/logger.js';
import { safeInteractionReply } from '../utils/interaction-helpers.js';
import { jobsOverview } from '../utils/database/media-jobs-pg.js';
import { botConfig, supportConfig } from '../utils/config.js';

const logger = createLogger('info');
const SITE_URL = 'https://gronka.dev';
const SOURCE_URL = 'https://github.com/gronkanium/gronka';

const mb = bytes => `${Math.round(bytes / 1024 ** 2)} MB`;

export function formatDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

export function uptimeLine(processMs, gatewayMs) {
  const line = formatDuration(processMs);
  if (Math.abs(processMs - gatewayMs) < 60000) return line;
  return `${line}\nconnected ${formatDuration(gatewayMs)}`;
}

export function memoryLine(botRss, processes, workersEnabled) {
  if (!workersEnabled) return mb(botRss);
  const workers = processes.filter(p => p.role === 'worker' && p.live && p.rss != null);
  const total = botRss + workers.reduce((sum, p) => sum + p.rss, 0);
  const n = workers.length;
  return `${mb(botRss)} bot\n${mb(total)} with ${n} worker${n === 1 ? '' : 's'}`;
}

export function queueLine(overview, workersEnabled) {
  if (!workersEnabled) return 'jobs run in the bot';
  const { queued, running } = overview.counts;
  const parts = [];
  if (overview.paused) parts.push('paused');
  if (running + queued) parts.push(`${running} running · ${queued} waiting`);
  return parts.join(' · ') || 'idle';
}

export function infoEmbed({ botStartTime, client, overview, workersEnabled, botRss, inviteUrl }) {
  const uptime = botStartTime ? Date.now() - botStartTime : process.uptime() * 1000;
  const links = [
    `[gronka.dev](${SITE_URL})`,
    inviteUrl && `[support server](${inviteUrl})`,
    `[source code](${SOURCE_URL})`,
  ].filter(Boolean);
  const field = (name, value) => ({ name, value, inline: true });
  return new EmbedBuilder()
    .setAuthor({ name: 'gronka', iconURL: client.user?.displayAvatarURL(), url: SITE_URL })
    .setColor(0x5865f2)
    .setDescription(`paste a link, get the file.\n${links.join(' · ')}`)
    .addFields(
      field('servers', client.guilds.cache.size.toLocaleString('en-US')),
      field('uptime', uptimeLine(uptime, client.uptime ?? 0)),
      field('queue', queueLine(overview, workersEnabled)),
      field('memory', memoryLine(botRss, overview.processes, workersEnabled)),
      field('version', `[v${pkg.version}](${SOURCE_URL}/releases/tag/v${pkg.version})`),
      field('runtime', `bun ${process.versions.bun}\ndiscord.js ${discordVersion}`)
    )
    .setFooter({ text: `${os.platform()} ${os.arch()} · ${os.cpus().length} cpus` })
    .setTimestamp();
}

export async function handleInfoCommand(interaction, botStartTime) {
  try {
    const overview = await jobsOverview({ limit: 1 });
    const embed = infoEmbed({
      botStartTime,
      client: interaction.client,
      overview,
      workersEnabled: botConfig.mediaWorkers,
      botRss: process.memoryUsage().rss,
      inviteUrl: supportConfig.inviteUrl,
    });
    await safeInteractionReply(interaction, { embeds: [embed] });
  } catch (error) {
    logger.error('Failed to get info:', error);
    await safeInteractionReply(interaction, {
      content: 'an error occurred while fetching bot information.',
      flags: MessageFlags.Ephemeral,
    });
  }
}
