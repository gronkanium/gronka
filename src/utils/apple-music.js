import { NetworkError, ValidationError, withCause } from './errors.js';
import { fetchPage } from './ssrf-guard.js';
import { hostOf, hostUnder } from './url-host.js';
import { downloadMatchedTrack } from './soundcloud.js';

export const APPLE_MUSIC_HOSTS = ['music.apple.com'];

export const isAppleMusicUrl = url => hostUnder(hostOf(url), APPLE_MUSIC_HOSTS);

// Apple Music audio is FairPlay-only; the lookup API names the song, artist and length, even of an album-only track.
export async function appleMusicTrack(url) {
  const { pathname, searchParams } = new URL(url);
  const store = /^\/([a-z]{2})\//.exec(pathname)?.[1];
  const id = /^\/[a-z]{2}\/album\//.test(pathname)
    ? /^\d+$/.exec(searchParams.get('i') ?? '')?.[0]
    : /^\/[a-z]{2}\/song\/(?:[^/]+\/)?(\d+)$/.exec(pathname)?.[1];
  if (!store || !id) {
    throw new ValidationError(
      'only apple music song and album links work: playlists and artists are not supported.'
    );
  }
  const failMessage = "couldn't read that apple music song right now.";
  const { data } = await fetchPage(`https://itunes.apple.com/lookup?id=${id}&country=${store}`, {
    failMessage,
    responseType: 'json',
  });
  if (Array.isArray(data?.results) && !data.results.length) {
    throw withCause(
      new NetworkError("that apple music song isn't in that store anymore.", 'CONTENT_GONE'),
      `apple music: lookup has no song ${id} in ${store}`
    );
  }
  const song = data?.results?.find(result => result.wrapperType === 'track');
  if (!song?.trackName || !song.artistName || !song.trackTimeMillis) {
    throw withCause(new NetworkError(failMessage), `apple music: lookup has no song ${id}`);
  }
  return {
    site: 'apple music',
    title: song.trackName,
    artist: song.artistName,
    duration: Math.floor(song.trackTimeMillis / 1000),
    year: song.releaseDate?.slice(0, 4) ?? null,
    genre:
      song.primaryGenreName && song.primaryGenreName !== 'Music' ? song.primaryGenreName : null,
    cover: song.artworkUrl100?.replace(/\/\d+x\d+bb(\.\w+)?$/, '/600x600bb.jpg') ?? null,
  };
}

export async function appleAlbumTracks(store, id) {
  const { data } = await fetchPage(
    `https://itunes.apple.com/lookup?id=${id}&entity=song&country=${store}&limit=200`,
    { failMessage: "couldn't read that apple music album right now.", responseType: 'json' }
  );
  const results = data?.results ?? [];
  const album = results.find(result => result.wrapperType === 'collection');
  const songs = results
    .filter(result => result.wrapperType === 'track' && result.trackViewUrl)
    .sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber);
  return {
    title: album?.collectionName ?? null,
    total: album?.trackCount ?? null,
    entries: songs.map(song => ({
      url: song.trackViewUrl,
      title: song.trackName ?? null,
      artist: song.artistName ?? null,
      duration: song.trackTimeMillis ? Math.floor(song.trackTimeMillis / 1000) : null,
    })),
  };
}

export const downloadFromAppleMusic = async url => downloadMatchedTrack(await appleMusicTrack(url));
