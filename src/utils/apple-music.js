import { NetworkError, ValidationError, withCause } from './errors.js';
import { fetchPage } from './ssrf-guard.js';
import { hostOf, hostUnder } from './url-host.js';
import { downloadMatchedTrack } from './soundcloud.js';

export const APPLE_MUSIC_HOSTS = ['music.apple.com'];

export const isAppleMusicUrl = url => hostUnder(hostOf(url), APPLE_MUSIC_HOSTS);

const seconds = iso => {
  const [, h = 0, m = 0, s = 0] = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? '') ?? [];
  return h * 3600 + m * 60 + Number(s);
};

// Apple Music audio is FairPlay-only, but the song page's JSON-LD names the song, artist and length.
export async function appleMusicTrack(url) {
  const { pathname, searchParams } = new URL(url);
  const store = /^\/([a-z]{2})\//.exec(pathname)?.[1];
  const id = /^\/[a-z]{2}\/album\//.test(pathname)
    ? /^\d+$/.exec(searchParams.get('i') ?? '')?.[0]
    : /^\/[a-z]{2}\/song\/(?:[^/]+\/)?(\d+)$/.exec(pathname)?.[1];
  if (!store || !id) {
    throw new ValidationError(
      'only apple music song links work: albums, playlists and artists are not supported.'
    );
  }
  const failMessage = "couldn't read that apple music song right now.";
  const { data: html } = await fetchPage(`https://music.apple.com/${store}/song/${id}`, {
    failMessage,
  });
  const json = /<script[^>]*id="?schema:song"?[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  let song;
  try {
    song = JSON.parse(json).audio;
  } catch {
    song = null;
  }
  const duration = seconds(song?.duration);
  const artist = song?.byArtist?.[0]?.name;
  if (!song?.name || !artist || !duration) {
    throw withCause(new NetworkError(failMessage), `apple music: song ${id} page has no song data`);
  }
  return {
    site: 'apple music',
    title: song.name,
    artist,
    duration,
    year: song.datePublished?.slice(0, 4) ?? null,
    genre: song.genre?.find(genre => genre !== 'Music') ?? null,
    cover: song.image?.replace(/\/\d+x\d+bb(\.\w+)?$/, '/600x600bb.jpg') ?? null,
  };
}

export const downloadFromAppleMusic = async url => downloadMatchedTrack(await appleMusicTrack(url));
