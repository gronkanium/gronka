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

export const isBilibiliCdnHost = host =>
  /(^|\.)bilivideo\.(com|cn)$|^upos-[\w-]+\.akamaized\.net$/.test(host ?? '');

// The host is the domain or one of its subdomains, for any of `domains` (a string or a list).
export const hostUnder = (host, domains) =>
  Boolean(host) && [domains].flat().some(d => host === d || host.endsWith(`.${d}`));
