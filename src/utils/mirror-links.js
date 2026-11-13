import { normalizeHost, hostUnder } from './url-host.js';

// Embed-fixer mirror domains people paste instead of x.com, mapped to the canonical host Cobalt understands. Cobalt doesn't
// know these hosts, so they must always be rewritten before the API call.
export const EMBED_FIXER_HOSTS = new Map([
  // FxEmbed (fxtwitter) and its community instances
  ['fxtwitter.com', 'twitter.com'],
  ['fixupx.com', 'twitter.com'],
  ['twittpr.com', 'twitter.com'],
  ['pxtwitter.com', 'twitter.com'],
  ['cunnyx.com', 'twitter.com'],
  ['girlcockx.com', 'twitter.com'],
  ['stupidpenisx.com', 'twitter.com'],
  ['chudx.com', 'twitter.com'],
  ['forsenx.com', 'twitter.com'],
  ['ucobx.com', 'twitter.com'],
  ['yiffx.com', 'twitter.com'],
  ['boycuntx.com', 'twitter.com'],
  ['boypussyx.com', 'twitter.com'],
  ['catgirlsex.com', 'twitter.com'],
  ['mpregx.com', 'twitter.com'],
  ['furryfeetx.com', 'twitter.com'],
  ['hotyurisex.com', 'twitter.com'],
  ['yurisex.com', 'twitter.com'],
  ['yaoisex.com', 'twitter.com'],
  ['skibidix.com', 'twitter.com'],
  ['peepeepoopoodumdumtwitterx.org', 'twitter.com'],
  ['imthehottest18yearoldononlyfansx.com', 'twitter.com'],
  ['x1tt3r.com', 'twitter.com'],
  ['ios.horse', 'twitter.com'],
  ['x.embed.rip', 'twitter.com'],
  ['dormiex.com', 'twitter.com'],
  ['pinkcatx.com', 'twitter.com'],
  ['femboysx.com', 'twitter.com'],
  ['forsen.sex', 'twitter.com'],
  ['megapenispoopenfarten.sex', 'twitter.com'],
  ['kroniigirlcockx.com', 'twitter.com'],
  ['kittycockx.com', 'twitter.com'],
  ['fixgirldix.com', 'twitter.com'],
  ['sandycheekscockvorex.com', 'twitter.com'],
  ['boberx.com', 'twitter.com'],
  ['faggotx.com', 'twitter.com'],
  ['hitlerx.com', 'twitter.com'],
  ['goyimx.com', 'twitter.com'],
  ['epsteinx.com', 'twitter.com'],
  ['autistic.kids', 'twitter.com'],
  ['niggerfaggotx.com', 'twitter.com'],
  ['stupidfaggotlittlecocksuckerx.com', 'twitter.com'],
  // BetterTwitFix (vxtwitter)
  ['vxtwitter.com', 'twitter.com'],
  ['fixvx.com', 'twitter.com'],
  ['twitterez.com', 'twitter.com'],
  ['xeezz.com', 'twitter.com'],
  ['gubbyx.com', 'twitter.com'],
  ['pawbsx.com', 'twitter.com'],
  // Nitter front ends keep x.com's paths
  ['xcancel.com', 'twitter.com'],
  ['nitter.tiekoetter.com', 'twitter.com'],
  ['fxbsky.app', 'bsky.app'],
  ['bskx.app', 'bsky.app'],
  ['bskyx.app', 'bsky.app'],
  ['bsyy.app', 'bsky.app'],
  ['vxbsky.app', 'bsky.app'],
  ['bskye.app', 'bsky.app'],
  ['boobsky.app', 'bsky.app'],
  ['xbsky.app', 'bsky.app'],
  // ddinstagram.com omitted: no longer resolves.
  ['kkinstagram.com', 'instagram.com'],
  ['eeinstagram.com', 'instagram.com'],
  ['vxinstagram.com', 'instagram.com'],
  ['zzinstagram.com', 'instagram.com'],
  ['uuinstagram.com', 'instagram.com'],
  ['instagramfix.com', 'instagram.com'],
  ['toinstagram.com', 'instagram.com'],
  ['fxig.seria.moe', 'instagram.com'],
  ['67instagram.com', 'instagram.com'],
  ['instagramez.com', 'instagram.com'],
  ['rxddit.com', 'reddit.com'],
  ['vxreddit.com', 'reddit.com'],
  ['fxreddit.seria.moe', 'reddit.com'],
  ['redditez.com', 'reddit.com'],
  ['tnktok.com', 'tiktok.com'],
  ['tfxktok.com', 'tiktok.com'],
  ['vxtiktok.com', 'tiktok.com'],
  ['tiktxk.com', 'tiktok.com'],
  ['fixtiktok.com', 'tiktok.com'],
  ['dxtiktok.com', 'tiktok.com'],
  ['cocktiktok.com', 'tiktok.com'],
  ['kktiktok.com', 'tiktok.com'],
  ['tiktokez.com', 'tiktok.com'],
  ['tt.site', 'tiktok.com'],
  ['youtube-nocookie.com', 'youtube.com'],
  ['koutube.com', 'youtube.com'],
  ['fixyoutube.com', 'youtube.com'],
  ['yfxtube.com', 'youtube.com'],
  ['koutu.be', 'youtu.be'],
  ['fxyoutu.be', 'youtu.be'],
  ['fixthreads.seria.moe', 'threads.com'],
  ['facebed.com', 'facebook.com'],
  ['facebookez.com', 'facebook.com'],
  ['vxbilibili.com', 'bilibili.com'],
  ['fxbilibili.seria.moe', 'bilibili.com'],
  ['bilibiliez.com', 'bilibili.com'],
  ['tpmblr.com', 'tumblr.com'],
  ['txtumblr.com', 'tumblr.com'],
  ['fxtwitch.seria.moe', 'twitch.tv'],
  ['fixdeviantart.com', 'deviantart.com'],
  ['pinterestez.com', 'pinterest.com'],
]);

// Fixers keep minting <letters>instagram.com hosts (kkinstagram, kkkinstagram...), so match the shape too.
export const mirrorTarget = host => {
  // Fixers serve direct-file links under a d. prefix (d.tiktokez.com, d.vxtwitter.com).
  if (host.startsWith('d.') && EMBED_FIXER_HOSTS.has(host.slice(2))) host = host.slice(2);
  // TikTok mirrors keep the app's vm./vt. share-link prefix in front of their own domain.
  const short = /^(vm|vt)\.(.+)$/.exec(host);
  if (short && EMBED_FIXER_HOSTS.get(short[2]) === 'tiktok.com') return `${short[1]}.tiktok.com`;
  return (
    EMBED_FIXER_HOSTS.get(host) ??
    (/^[a-z0-9-]+instagram\.com$/.test(host) ? 'instagram.com' : undefined)
  );
};

const REDDIT_SHORT_PATH = /^\/([a-z0-9]+)\/?$/i;
const REDDIT_GALLERY_PATH = /^\/gallery\/([a-z0-9]+)\/?$/i;
const GIPHY_PAGE_PATH = /^\/(?:gifs|stickers|embed)\/(?:[^/]*-)?([A-Za-z0-9]+)\/?$/;

// Canonicalize before routing: the Instagram extractor matches canonical hosts only.
export function canonicalizeMirrorUrl(url) {
  try {
    const urlObj = new URL(url);
    // A giphy page's id maps straight to its gif, so it routes as a direct media link.
    const giphyId = /^(www\.)?giphy\.com$/i.test(urlObj.hostname)
      ? urlObj.pathname.match(GIPHY_PAGE_PATH)?.[1]
      : null;
    if (giphyId) {
      return `https://i.giphy.com/${giphyId}.gif`;
    }
    const canonicalHost = mirrorTarget(normalizeHost(urlObj.hostname));
    const host = canonicalHost ?? normalizeHost(urlObj.hostname);
    // Reddit 403s a bot following these redirects; /comments/<id> is what they point at.
    const redditId =
      host === 'redd.it'
        ? urlObj.pathname.match(REDDIT_SHORT_PATH)?.[1]
        : hostUnder(host, ['reddit.com'])
          ? urlObj.pathname.match(REDDIT_GALLERY_PATH)?.[1]
          : null;
    if (redditId) {
      return `https://www.reddit.com/comments/${redditId}`;
    }
    if (!canonicalHost) {
      return url;
    }
    urlObj.hostname = canonicalHost;
    return urlObj.toString();
  } catch {
    return url;
  }
}
