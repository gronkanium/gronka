import { NetworkError, ValidationError, withCause } from './errors.js';
import { fetchPage } from './ssrf-guard.js';
import { hostOf, hostUnder } from './url-host.js';
import { downloadMatchedTrack, norm, tagAudio } from './soundcloud.js';
import { downloadDirectMedia } from './file-downloader.js';

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

function spotifyLink(url) {
  const [, kind, id] =
    /^\/(?:intl-[\w-]+\/|embed(?:-podcast)?\/)?(track|episode)\/([A-Za-z0-9]{22})\b/.exec(
      hostOf(url) === 'open.spotify.com' ? new URL(url).pathname : ''
    ) ?? [];
  if (!id) {
    throw new ValidationError(
      'only spotify track and episode links work: albums, playlists, artists and shows are not supported.'
    );
  }
  return { kind, id };
}

// Spotify audio is DRM-only, but the public track page names the song, artist and length.
export async function spotifyTrack(url) {
  const { id } = spotifyLink(url);
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

export async function spotifyEpisode(url) {
  const { id } = spotifyLink(url);
  const failMessage = "couldn't read that spotify episode right now.";
  const { data: html } = await fetchPage(`https://open.spotify.com/episode/${id}`, {
    failMessage,
  });
  const title = meta(html, 'og:title');
  const show = /^(.+) · Episode$/.exec(decode(meta(html, 'og:description') ?? ''))?.[1];
  if (!title || !show) {
    throw withCause(new NetworkError(failMessage), `spotify: episode ${id} page has no show meta`);
  }
  return {
    title: decode(title),
    show,
    year: meta(html, 'music:release_date')?.slice(0, 4) ?? null,
  };
}

const appleDirectory = async (path, query) => {
  const params = new URLSearchParams({ media: 'podcast', limit: '200', ...query });
  const { data } = await fetchPage(`https://itunes.apple.com/${path}?${params}`, {
    failMessage: "couldn't look that podcast up right now.",
    responseType: 'json',
  });
  return data?.results ?? [];
};

// Spotify's own episode audio is DRM-only; the show's public feed, found through Apple's podcast directory, has the same file.
export async function feedEpisode(episode) {
  const ids = (await appleDirectory('search', { entity: 'podcast', term: episode.show }))
    .filter(show => norm(show.collectionName) === norm(episode.show))
    .map(show => show.collectionId);
  if (!ids.length) {
    throw withCause(
      new ValidationError(
        'that podcast is only on spotify, which encrypts its audio (drm).',
        'DRM_PROTECTED'
      ),
      `apple podcasts: no show named "${episode.show}"`
    );
  }
  const same = results =>
    results.find(
      found =>
        ids.includes(found.collectionId) &&
        found.episodeUrl &&
        norm(found.trackName) === norm(episode.title)
    );
  const found =
    same(await appleDirectory('lookup', { id: ids.join(','), entity: 'podcastEpisode' })) ??
    same(await appleDirectory('search', { entity: 'podcastEpisode', term: episode.title }));
  if (!found) {
    throw withCause(
      new ValidationError("that episode isn't in the podcast's public feed, only on spotify."),
      `apple podcasts: shows ${ids.join(',')} have no episode titled "${episode.title}"`
    );
  }
  return found;
}

async function downloadEpisode(url) {
  const episode = await spotifyEpisode(url);
  const found = await feedEpisode(episode);
  const file = await downloadDirectMedia(found.episodeUrl);
  return tagAudio(file, {
    title: episode.title,
    artist: episode.show,
    year: episode.year,
    genre: null,
    cover: found.artworkUrl600 ?? null,
  });
}

export const downloadFromSpotify = async url =>
  spotifyLink(url).kind === 'episode'
    ? downloadEpisode(url)
    : downloadMatchedTrack(await spotifyTrack(url));
