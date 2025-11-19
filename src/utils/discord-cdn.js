import { createLogger } from './logger.js';

const logger = createLogger('discord-cdn');

/**
 * Check if URL is a Discord CDN URL
 * @param {string} url - URL to check
 * @returns {boolean} True if URL is from Discord CDN
 */
export function isDiscordCdnUrl(url) {
  try {
    const urlObj = new URL(url);
    // Only allow http and https protocols
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return false;
    }
    return (
      urlObj.hostname === 'cdn.discordapp.com' ||
      urlObj.hostname === 'media.discordapp.net' ||
      urlObj.hostname.endsWith('.discordapp.com') ||
      urlObj.hostname.endsWith('.discordapp.net')
    );
  } catch {
    return false;
  }
}

/**
 * Check if attachment URL has expired
 * @param {string} url - URL to check
 * @returns {boolean} True if URL is expired or invalid
 */
export function isAttachmentExpired(url) {
  try {
    const urlObj = new URL(url);
    const expiry = urlObj.searchParams.get('ex');
    if (!expiry || expiry.length > 8) {
      return true;
    }
    // Parse hex expiry timestamp and compare with current time
    const expiryTime = parseInt(`0x${expiry}`, 16) * 1000;
    // If parsing failed (NaN), consider it expired
    if (isNaN(expiryTime) || !isFinite(expiryTime)) {
      return true;
    }
    return Date.now() >= expiryTime;
  } catch {
    return true;
  }
}

/**
 * Refresh the attachment URL if expired using Discord's REST API
 * @param {Client} client - Discord client instance
 * @param {string} attachmentURL - Original attachment URL
 * @returns {Promise<string>} Refreshed URL or original URL if not needed
 */
export async function getRefreshedAttachmentURL(client, attachmentURL) {
  try {
    const url = new URL(attachmentURL);

    // Check if it's a Discord CDN URL
    if (
      (url.hostname === 'cdn.discordapp.com' || url.hostname === 'media.discordapp.net') &&
      url.pathname.match(/^\/(?:ephemeral-)?attachments\/\d+\/\d+\//)
    ) {
      // Check if expired or missing query parameters
      if (isAttachmentExpired(attachmentURL) || !url.search || url.search.length === 0) {
        logger.info(`Refreshing expired or invalid Discord CDN URL: ${attachmentURL}`);
        // Use Discord's REST API to refresh the URL
        const response = await client.rest.post('/attachments/refresh-urls', {
          body: {
            attachment_urls: [attachmentURL],
          },
        });

        if (
          response.refreshed_urls &&
          response.refreshed_urls[0] &&
          response.refreshed_urls[0].refreshed
        ) {
          const refreshedURL = new URL(response.refreshed_urls[0].refreshed);
          refreshedURL.searchParams.set('animated', 'true');
          logger.info(`Successfully refreshed URL: ${refreshedURL.toString()}`);
          return refreshedURL.toString();
        }
      }
    }
  } catch (error) {
    logger.warn(`Failed to refresh attachment URL: ${error.message}`);
    // Return original URL if refresh fails
  }

  return attachmentURL;
}

/**
 * Get common headers for HTTP requests (needed for Discord CDN and other services)
 * @returns {Object} Headers object
 */
export function getRequestHeaders() {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    Referer: 'https://discord.com/',
  };
}
