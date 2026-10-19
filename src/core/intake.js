import { firstUrlIn, validateUrl } from '../utils/validation.js';
import { resolveShortLink } from '../utils/short-links.js';
import { canonicalizeMirrorUrl } from '../utils/cobalt.js';
import { isDiscordMessageLink, DISCORD_MESSAGE_LINK_MESSAGE } from '../utils/discord-cdn.js';
import { routeFor, isEnabled } from './sources.js';

// Every front door (slash, prefix, context menu, web) takes a link through these, in order:
// readLink (which link, is it safe), prepareLink (where it really points), refusalFor (can we take it).
export function readLink(text, missingMessage = 'please provide a URL.') {
  if (!text?.trim()) return { refusal: { message: missingMessage, reason: 'missing_url' } };
  const url = firstUrlIn(text) ?? text.trim();
  const check = validateUrl(url);
  if (!check.valid) {
    return { refusal: { message: `invalid URL: ${check.error}`, reason: 'invalid_url' } };
  }
  return { url };
}

export const prepareLink = async url => canonicalizeMirrorUrl(await resolveShortLink(url));

export function refusalFor(url) {
  const source = routeFor(url);
  if (source && !isEnabled(source)) {
    return {
      message: source.disabledMessage(url),
      reason: `${source.id.replace('-', '_')}_disabled`,
    };
  }
  if (source) return null;
  if (isDiscordMessageLink(url)) {
    return { message: DISCORD_MESSAGE_LINK_MESSAGE, reason: 'discord_message_link' };
  }
  return {
    message: 'url is not from a supported social media platform.',
    reason: 'invalid_social_media_url',
  };
}
