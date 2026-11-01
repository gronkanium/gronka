import { NetworkError, ValidationError, withCause } from './errors.js';
import { fetchPage } from './ssrf-guard.js';
import { hostOf, hostUnder } from './url-host.js';
import { trackViaYoutube } from './soundcloud.js';

export const SPOTIFY_HOSTS = ['open.spotify.com', 'spotify.link', 'spotify.app.link'];

export const isSpotifyUrl = url => hostUnder(hostOf(url), SPOTIFY_HOSTS);

const decode = value =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const meta = (html, key) =>
  new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1];

// Spotify audio is DRM-only, but the public track page names the song, artist and length.
export async function spotifyTrack(url) {
  const id = /^\/(?:intl-[\w-]+\/)?track\/([A-Za-z0-9]{22})\b/.exec(
    hostOf(url) === 'open.spotify.com' ? new URL(url).pathname : ''
  )?.[1];
  if (!id) {
    throw new ValidationError(
      'only spotify track links work: albums, playlists, artists and podcasts are not supported.'
    );
  }
  const failMessage = "couldn't read that spotify track right now.";
  const { data: html } = await fetchPage(`https://open.spotify.com/track/${id}`, { failMessage });
  const title = meta(html, 'og:title');
  const artist = meta(html, 'music:musician_description');
  const duration = Number(meta(html, 'music:duration'));
  if (!title || !artist || !duration) {
    throw withCause(new NetworkError(failMessage), `spotify: track ${id} page has no track meta`);
  }
  return {
    site: 'spotify',
    title: decode(title),
    artist: decode(artist),
    duration,
    year: meta(html, 'music:release_date')?.slice(0, 4) ?? null,
    genre: null,
    cover: meta(html, 'og:image') ?? null,
  };
}

export const downloadFromSpotify = async url => trackViaYoutube(await spotifyTrack(url));
