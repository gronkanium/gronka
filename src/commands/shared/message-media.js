import { firstUrlIn } from '../../utils/validation.js';

export function messageMediaInput(message, selectAttachment) {
  const sources = [message, ...(message.messageSnapshots?.values() ?? [])];
  for (const source of sources) {
    const attachment = selectAttachment([...(source.attachments?.values() ?? [])]);
    if (attachment) return { attachment, url: null };
  }
  for (const source of sources) {
    const url =
      firstUrlIn(source.content) ??
      source.embeds?.map(embed => embed.video?.url ?? embed.image?.url).find(Boolean);
    if (url) return { attachment: null, url };
  }
  return { attachment: null, url: null };
}
