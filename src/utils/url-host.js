export const normalizeHost = hostname => hostname.toLowerCase().replace(/^www\./, '');

// The host of a URL without its www., or null when it does not parse.
export function hostOf(url) {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

// Every link in a piece of text cut down to its host.
export const hostsOnly = text =>
  text?.replace(/https?:\/\/[^\s"'<>)]+/gi, url => hostOf(url) ?? '<link>') ?? null;
