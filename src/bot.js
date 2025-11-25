import { Client, GatewayIntentBits, Events, AttachmentBuilder } from 'discord.js';
import { createLogger } from './utils/logger.js';
import { botConfig } from './utils/config.js';
import { ConfigurationError } from './utils/errors.js';
import { trackUser, initializeUserTracking } from './utils/user-tracking.js';
import { handleStatsCommand } from './commands/stats.js';
import { handleDownloadCommand, handleDownloadContextMenuCommand } from './commands/download.js';
import { handleOptimizeCommand, handleOptimizeContextMenuCommand } from './commands/optimize.js';
import { handleConvertCommand, handleConvertContextMenu } from './commands/convert.js';
import { handleInfoCommand } from './commands/info.js';
import { handleModalSubmit } from './handlers/modals.js';
import { initQueue, startQueueProcessor, addToQueue } from './utils/deferred-download-queue.js';
import {
  notifyDownloadComplete,
  notifyDownloadFailed,
} from './utils/deferred-download-notifier.js';
import { isAdmin } from './utils/rate-limit.js';
import { queueCobaltRequest, hashUrl } from './utils/cobalt-queue.js';
import { downloadFromSocialMedia } from './utils/cobalt.js';
import { getProcessedUrl, insertProcessedUrl, initDatabase } from './utils/database.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { generateHash } from './utils/file-downloader.js';
import {
  createOperation,
  updateOperationStatus,
  cleanupStuckOperations,
} from './utils/operations-tracker.js';
import {
  gifExists,
  getGifPath,
  videoExists,
  getVideoPath,
  imageExists,
  getImagePath,
  saveGif,
  saveVideo,
  saveImage,
  detectFileType,
  initializeR2UsageCache,
  shouldUploadToDiscord,
} from './utils/storage.js';
import { getUserConfig } from './utils/user-config.js';
import { optimizeGif } from './utils/gif-optimizer.js';

// Initialize logger
const logger = createLogger('bot');

// Configuration from centralized config
const {
  discordToken: DISCORD_TOKEN,
  clientId: CLIENT_ID,
  gifStoragePath: GIF_STORAGE_PATH,
  cdnBaseUrl: CDN_BASE_URL,
} = botConfig;

// Store attachment info for modal submissions: customId -> { attachment, attachmentType, adminUser, preDownloadedBuffer }
const modalAttachmentCache = new Map();

// Clean up modal cache entries older than 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of modalAttachmentCache.entries()) {
    if (value.timestamp && now - value.timestamp > 5 * 60 * 1000) {
      modalAttachmentCache.delete(key);
    }
  }
}, 60 * 1000); // Run cleanup every minute

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages, // Required for DM support
    GatewayIntentBits.MessageContent, // Required to access attachments
  ],
});

// Track bot start time for uptime
let botStartTime = null;

// Event handlers
client.once(Events.ClientReady, async readyClient => {
  botStartTime = Date.now();
  await initializeUserTracking();

  // Initialize deferred download queue
  await initQueue();

  // Start queue processor with callback to handle deferred downloads
  startQueueProcessor(async queueItem => {
    return await processDeferredDownload(queueItem);
  });

  readyClient.user.setPresence({ status: 'dnd' });
  logger.info(`bot logged in as ${readyClient.user.tag}`);
  logger.info(`gif storage: ${GIF_STORAGE_PATH}`);
  logger.info(`cdn url: ${CDN_BASE_URL}`);

  // Initialize R2 usage cache on startup (if R2 is configured)
  // This caches R2 stats to limit class A operations (LIST requests) for the /stats Discord command
  await initializeR2UsageCache();

  // Clean up stuck operations every 5 minutes
  setInterval(
    async () => {
      try {
        await cleanupStuckOperations(10, readyClient); // 10 minute timeout, pass client for DM notifications
      } catch (error) {
        logger.error('Error in stuck operations cleanup:', error);
      }
    },
    5 * 60 * 1000
  ); // Run cleanup every 5 minutes
});

client.on(Events.InteractionCreate, async interaction => {
  logger.debug(
    `Received interaction: ${interaction.type} from user ${interaction.user.id} (${interaction.user.tag})`
  );
  // Track user interaction (non-blocking to avoid interaction timeout)
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  trackUser(interaction.user.id, username).catch(error => {
    logger.debug(`Failed to track user ${interaction.user.id}: ${error.message}`);
  });

  // Handle button interactions
  if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
  } else if (interaction.isModalSubmit()) {
    await handleModalSubmit(interaction, modalAttachmentCache);
  } else if (interaction.isMessageContextMenuCommand()) {
    // Route to appropriate handler based on command name
    if (interaction.commandName === 'download') {
      await handleDownloadContextMenuCommand(interaction);
    } else if (interaction.commandName === 'optimize') {
      await handleOptimizeContextMenuCommand(interaction, modalAttachmentCache);
    } else if (interaction.commandName === 'convert to gif') {
      await handleConvertContextMenu(interaction);
    }
  } else if (interaction.isChatInputCommand()) {
    const commandName = interaction.commandName;

    if (commandName === 'stats') {
      await handleStatsCommand(interaction, botStartTime);
    } else if (commandName === 'download') {
      await handleDownloadCommand(interaction);
    } else if (commandName === 'optimize') {
      await handleOptimizeCommand(interaction);
    } else if (commandName === 'convert') {
      await handleConvertCommand(interaction);
    } else if (commandName === 'info') {
      await handleInfoCommand(interaction);
    }
  }
});

/**
 * Handle button interactions for deferred downloads
 * @param {Interaction} interaction - Button interaction
 */
async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;

  if (customId.startsWith('defer_download:')) {
    // Extract URL from custom ID
    const base64Url = customId.replace('defer_download:', '');
    const url = Buffer.from(base64Url, 'base64').toString('utf-8');

    const userId = interaction.user.id;
    const username = interaction.user.tag || interaction.user.username || 'unknown';
    const adminUser = isAdmin(userId);

    logger.info(`User ${userId} (${username}) requested deferred download: ${url}`);

    try {
      // Initialize database if needed
      await initDatabase();

      // Check if URL has already been processed
      const urlHash = hashUrl(url);
      const processedUrl = await getProcessedUrl(urlHash);
      if (processedUrl) {
        logger.info(
          `Deferred download: URL already processed (hash: ${urlHash.substring(0, 8)}...), returning existing file URL immediately: ${processedUrl.file_url}`
        );
        await interaction.update({
          content: processedUrl.file_url,
          components: [],
        });
        return;
      }

      // Add to deferred queue
      const requestId = await addToQueue({
        url,
        userId,
        username,
        channelId: interaction.channelId,
        interactionToken: interaction.token,
        isAdmin: adminUser,
      });

      logger.info(`Added deferred download to queue: ${requestId}`);

      // Update the message to remove buttons
      await interaction.update({
        content: "download queued. you'll receive a notification when it's ready.",
        components: [],
      });
    } catch (error) {
      logger.error(`Failed to queue deferred download: ${error.message}`);
      await interaction.update({
        content: `failed to queue download: ${error.message}`,
        components: [],
      });
    }
  } else if (customId === 'cancel_download') {
    logger.info(`User ${interaction.user.id} cancelled deferred download`);

    await interaction.update({
      content: 'download cancelled.',
      components: [],
    });
  }
}

/**
 * Process a deferred download from the queue
 * @param {Object} queueItem - Queue item to process
 * @returns {Promise<string>} Result message with download URL
 */
async function processDeferredDownload(queueItem) {
  const { url, userId, username, isAdmin: adminUser } = queueItem;

  logger.info(`Processing deferred download for user ${userId}: ${url}`);

  const userConfig = await getUserConfig(userId);
  const operationId = createOperation('deferred-download', userId, username);

  const buildMetadata = () => ({
    'user-id': userId,
    'upload-timestamp': new Date().toISOString(),
    'operation-type': 'deferred-download',
    username: username,
  });

  try {
    updateOperationStatus(operationId, 'running');

    // Initialize database if needed
    await initDatabase();

    // Check if URL has already been processed
    const urlHash = hashUrl(url);
    const processedUrl = await getProcessedUrl(urlHash);
    if (processedUrl) {
      logger.info(
        `Deferred download: URL already processed (hash: ${urlHash.substring(0, 8)}...), returning existing file URL: ${processedUrl.file_url}`
      );
      updateOperationStatus(operationId, 'success', { fileSize: 0 });
      await notifyDownloadComplete(client, queueItem, processedUrl.file_url, null, operationId, userId);
      return processedUrl.file_url;
    }

    const maxSize = adminUser ? Infinity : botConfig.maxVideoSize;

    // Download via queue with retry logic
    let fileData;
    try {
      fileData = await queueCobaltRequest(url, async () => {
        return await downloadFromSocialMedia(botConfig.cobaltApiUrl, url, adminUser, maxSize);
      });
    } catch (error) {
      // Handle cached URL error
      if (error.message && error.message.startsWith('URL_ALREADY_PROCESSED:')) {
        const fileUrl = error.message.split(':')[1];
        updateOperationStatus(operationId, 'success', { fileSize: 0 });
        await notifyDownloadComplete(client, queueItem, fileUrl, null, operationId, userId);
        return fileUrl;
      }
      throw error;
    }

    // Handle multiple photos
    if (Array.isArray(fileData)) {
      const photoResults = [];
      let totalSize = 0;

      for (let i = 0; i < fileData.length; i++) {
        const photo = fileData[i];
        const hash = generateHash(photo.buffer);
        const ext = path.extname(photo.filename).toLowerCase() || '.jpg';

        const exists = await imageExists(hash, ext, botConfig.gifStoragePath);
        let fileUrl;

        if (exists) {
          const filePath = getImagePath(hash, ext, botConfig.gifStoragePath);
          if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
            fileUrl = filePath;
          } else {
            const filename = path.basename(filePath);
            fileUrl = `${botConfig.cdnBaseUrl.replace('/gifs', '/images')}/${filename}`;
          }
        } else {
          const saveResult = await saveImage(
            photo.buffer,
            hash,
            ext,
            botConfig.gifStoragePath,
            buildMetadata()
          );
          const filePath = saveResult.url;

          if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
            fileUrl = filePath;
          } else {
            const filename = path.basename(filePath);
            fileUrl = `${botConfig.cdnBaseUrl.replace('/gifs', '/images')}/${filename}`;
          }
        }

        photoResults.push({ url: fileUrl, size: photo.size });
        totalSize += photo.size;
      }

      updateOperationStatus(operationId, 'success', {
        fileSize: totalSize,
        photoCount: photoResults.length,
      });

      // Note: For multiple photos, we don't record the URL in processed_urls
      // because each photo has its own URL, and we can't track which photo came from which picker selection
      // The file hash deduplication handles this case

      const photoUrls = photoResults.map(p => p.url).join('\n');
      const resultMessage = photoUrls;

      await notifyDownloadComplete(client, queueItem, resultMessage, null, operationId, userId);
      return resultMessage;
    }

    // Single file handling
    let hash = generateHash(fileData.buffer);
    const ext = path.extname(fileData.filename).toLowerCase() || '.mp4';
    const fileType = detectFileType(ext, fileData.contentType);

    let cdnPath = '/gifs';
    if (fileType === 'video') {
      cdnPath = '/videos';
    } else if (fileType === 'image') {
      cdnPath = '/images';
    }

    let exists = false;
    let filePath = null;
    let finalBuffer = fileData.buffer;
    let finalUploadMethod = 'r2';

    if (fileType === 'gif') {
      exists = await gifExists(hash, botConfig.gifStoragePath);
      if (exists) {
        filePath = getGifPath(hash, botConfig.gifStoragePath);
        // Read existing file to check size
        if (!filePath.startsWith('http://') && !filePath.startsWith('https://')) {
          finalBuffer = await fs.readFile(filePath);
          finalUploadMethod = shouldUploadToDiscord(finalBuffer) ? 'discord' : 'r2';
        }
      }
    } else if (fileType === 'video') {
      exists = await videoExists(hash, ext, botConfig.gifStoragePath);
      if (exists) {
        filePath = getVideoPath(hash, ext, botConfig.gifStoragePath);
        // Read existing file to check size
        if (!filePath.startsWith('http://') && !filePath.startsWith('https://')) {
          finalBuffer = await fs.readFile(filePath);
          finalUploadMethod = shouldUploadToDiscord(finalBuffer) ? 'discord' : 'r2';
        }
      }
    } else if (fileType === 'image') {
      exists = await imageExists(hash, ext, botConfig.gifStoragePath);
      if (exists) {
        filePath = getImagePath(hash, ext, botConfig.gifStoragePath);
        // Read existing file to check size
        if (!filePath.startsWith('http://') && !filePath.startsWith('https://')) {
          finalBuffer = await fs.readFile(filePath);
          finalUploadMethod = shouldUploadToDiscord(finalBuffer) ? 'discord' : 'r2';
        }
      }
    }

    if (exists && filePath) {
      let fileUrl;
      if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        fileUrl = filePath;
      } else {
        const filename = path.basename(filePath);
        fileUrl = `${botConfig.cdnBaseUrl.replace('/gifs', cdnPath)}/${filename}`;
      }

      let existingSize = fileData.buffer.length;
      if (!filePath.startsWith('http://') && !filePath.startsWith('https://')) {
        // Try to stat local file, but it might only exist in R2
        try {
          const stats = await fs.stat(filePath);
          existingSize = stats.size;
        } catch {
          // File only exists in R2, use buffer size as approximation
          logger.debug(`File exists in R2 but not locally, using buffer size: ${existingSize}`);
        }
      }

      // Record processed URL in database (file exists but URL might not be recorded yet)
      await insertProcessedUrl(
        urlHash,
        hash,
        fileType,
        ext,
        fileUrl,
        Date.now(),
        userId,
        existingSize
      );
      logger.debug(`Recorded processed URL in database (urlHash: ${urlHash.substring(0, 8)}...)`);

      updateOperationStatus(operationId, 'success', { fileSize: existingSize });
      const resultMessage = fileUrl;

      await notifyDownloadComplete(client, queueItem, resultMessage, null, operationId, userId);
      return resultMessage;
    }

    // Save file
    if (fileType === 'gif') {
      const saveResult = await saveGif(
        fileData.buffer,
        hash,
        botConfig.gifStoragePath,
        buildMetadata()
      );
      filePath = saveResult.url;
      finalBuffer = saveResult.buffer;
      finalUploadMethod = saveResult.method;

      if (userConfig.autoOptimize) {
        const optimizedHash = crypto.createHash('sha256');
        optimizedHash.update(fileData.buffer);
        optimizedHash.update('optimized');
        optimizedHash.update('35');
        const optimizedHashValue = optimizedHash.digest('hex');
        const optimizedGifPath = getGifPath(optimizedHashValue, botConfig.gifStoragePath);

        const optimizedExists = await gifExists(optimizedHashValue, botConfig.gifStoragePath);
        if (optimizedExists) {
          filePath = optimizedGifPath;
          hash = optimizedHashValue;
          // Read optimized buffer and re-check upload method
          if (!filePath.startsWith('http://') && !filePath.startsWith('https://')) {
            finalBuffer = await fs.readFile(optimizedGifPath);
            finalUploadMethod = shouldUploadToDiscord(finalBuffer) ? 'discord' : 'r2';
          }
        } else {
          // Check if filePath is a URL (R2-stored files return URLs, not local paths)
          if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
            logger.warn(
              `Auto-optimization skipped: GIF is stored in R2 (URL: ${filePath}). File must be available locally for optimization. User can manually optimize later if needed.`
            );
          } else {
            await optimizeGif(filePath, optimizedGifPath, { lossy: 35 });
            filePath = optimizedGifPath;
            hash = optimizedHashValue;
            // Read optimized buffer and re-check upload method
            finalBuffer = await fs.readFile(optimizedGifPath);
            finalUploadMethod = shouldUploadToDiscord(finalBuffer) ? 'discord' : 'r2';
          }
        }
      }
    } else if (fileType === 'video') {
      const saveResult = await saveVideo(
        fileData.buffer,
        hash,
        ext,
        botConfig.gifStoragePath,
        buildMetadata()
      );
      filePath = saveResult.url;
      finalBuffer = saveResult.buffer;
      finalUploadMethod = saveResult.method;
    } else if (fileType === 'image') {
      const saveResult = await saveImage(
        fileData.buffer,
        hash,
        ext,
        botConfig.gifStoragePath,
        buildMetadata()
      );
      filePath = saveResult.url;
      finalBuffer = saveResult.buffer;
      finalUploadMethod = saveResult.method;
    }

    let fileUrl;
    let finalSize;
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      fileUrl = filePath;
      finalSize = finalBuffer.length;
    } else {
      const filename = path.basename(filePath);
      fileUrl = `${botConfig.cdnBaseUrl.replace('/gifs', cdnPath)}/${filename}`;
      const finalStats = await fs.stat(filePath);
      finalSize = finalStats.size;
    }

    // Record processed URL in database
    await insertProcessedUrl(urlHash, hash, fileType, ext, fileUrl, Date.now(), userId, finalSize);
    logger.debug(`Recorded processed URL in database (urlHash: ${urlHash.substring(0, 8)}...)`);

    updateOperationStatus(operationId, 'success', { fileSize: finalSize });

    // Send as Discord attachment if < 8MB, otherwise send URL
    if (finalUploadMethod === 'discord') {
      const safeHash = hash.replace(/[^a-f0-9]/gi, '');
      const filename = `${safeHash}${ext}`;
      const attachment = new AttachmentBuilder(finalBuffer, { name: filename });
      await notifyDownloadComplete(client, queueItem, null, attachment, operationId, userId);
      return `File sent as attachment: ${filename}`;
    } else {
      await notifyDownloadComplete(client, queueItem, fileUrl, null, operationId, userId);
      return fileUrl;
    }
  } catch (error) {
    logger.error(`Deferred download failed for user ${userId}: ${error.message}`);
    updateOperationStatus(operationId, 'error', { error: error.message });

    await notifyDownloadFailed(client, queueItem, error.message, operationId, userId);
    throw error;
  }
}

client.on(Events.Error, error => {
  logger.error('Discord error:', error);
});

// Validate configuration
try {
  // Config validation happens during import, but check here for clarity
  if (!DISCORD_TOKEN || !CLIENT_ID) {
    throw new ConfigurationError('Required configuration missing');
  }
} catch (error) {
  if (error instanceof ConfigurationError) {
    logger.error('Configuration error:', error.message);
  } else {
    logger.error('Failed to load configuration:', error);
  }
  process.exit(1);
}

// Start bot
logger.info('Starting Discord bot...');
client.login(DISCORD_TOKEN).catch(error => {
  logger.error('an error occurred:', error);
  process.exit(1);
});

// Log shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});
