# content api

`POST /v1/content` on api.gronka.dev reads the text behind a link instead of the file: a post with
its author, stats and media, the author's own thread, replies, a video's details and captions, a
playlist's tracks, or a web page's article text. the answer is one json shape whatever the source,
so a script, a bot or a prompt parses it the same way. the live reference is
[openapi.json](https://gronka.dev/openapi.json) and the [docs page](https://gronka.dev/docs/#content).

status: public preview. the shape may still move before it leaves preview.

## request

```bash
curl https://api.gronka.dev/v1/content \
  -H 'Authorization: Bearer <key>' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.reddit.com/r/pics/comments/abc123/title/","depth":3,"comments":10}'
```

| field | type | default | applies to | what it does |
| --- | --- | --- | --- | --- |
| `url` | string | | all | a link, or text with a link in it. short links and mirrors work (see below) |
| `format` | `json` \| `text` | `json` | all | `text` renders the same content as plain text (see below) |
| `thread` | boolean | `true` | x, bluesky | rebuild the author's own thread around the linked post |
| `depth` | integer 0..10 | 10 | reddit | comment levels to include; `0` leaves the comments out |
| `comments` | integer 0..20 | 0 | reddit, x, bluesky, youtube | replies to include; off unless set |
| `transcript` | boolean or language code | `false` | youtube | add the captions as timed lines; `true` picks the video's own language |

short links (`t.co`, `vm.tiktok.com`, `spotify.link`, `on.soundcloud.com`, `redd.it`, reddit `/s/` links,
`pin.it` and others) and mirror domains (`fxtwitter.com`, `vxtwitter.com`, `kkinstagram.com` and
others) are resolved before the link is read.

auth, quota and turnstile are the same as `/v1/download`: an api key or the web page's turnstile
token, 50 requests per 10 minutes per caller, and the quota is shared between downloads and
content reads. the same link with the same options within a minute is answered from memory. unlike
downloads the answer is not padded: a read takes seconds, so the http status carries the outcome.

## sources

a link goes to the first reader in this order that takes it; `source` in the answer names it.

| `source` | links |
| --- | --- |
| `reddit` | post and comment permalinks |
| `twitter` | x.com and twitter.com posts |
| `bluesky` | bsky.app posts |
| `instagram` | posts, reels and tv links |
| `threads` | threads.com and threads.net posts |
| `tiktok` | videos and photo posts |
| `booru` | danbooru, e621, e926, yande.re and konachan posts |
| `pinterest` | pins |
| `list` | youtube playlists (`/playlist?list=`), soundcloud sets, spotify albums and playlists, apple music albums |
| `video` | youtube, soundcloud, twitch, vimeo, dailymotion and the other sites the downloader reads with yt-dlp |
| `page` | any other http(s) link |

## response: `Thread`

```json
{
  "source": "twitter",
  "url": "https://x.com/user/status/123",
  "post": { "...": "Post" },
  "thread": [{ "...": "Post" }, { "...": "Post" }],
  "comments": [{ "...": "Comment" }],
  "truncated": false
}
```

- `source`: the reader, from the table above.
- `url`: the canonical link.
- `post`: the item the link points at.
- `thread`: the author's own posts in order, the post included. x and bluesky only; empty when the
  post stands alone.
- `comments`: replies by other people, as a tree; empty unless `comments` is set, and never more
  than 20. a sample, not the whole conversation.
- `truncated`: true when something was left out: replies past `comments` or `depth`, replies reddit
  folded away, a thread walk that hit its cap or a post it could not read, x replies asked for with
  no session to read them, or a list longer than 100 entries. reddit only sets it when `comments`
  was asked for. youtube sets it when as many comments came back as were asked for.

### `Post`

| field | notes |
| --- | --- |
| `id`, `url` | the source's id and a canonical permalink |
| `author` | `{ handle, name, url }`; `handle` is the `@name` or `u/name` without the prefix, null when deleted or unknown |
| `createdAt` | iso 8601 utc, or null |
| `title` | a reddit post, x article, pin, video, list or page title; null elsewhere |
| `text` | the body as plain text. reddit markdown is left as written, x gives the full long post or article text, a page gives its article text or else its description |
| `media` | `[{ type: image \| video \| gif \| audio, url, alt, width, height }]` in the order posted; video sites add `duration` in seconds |
| `links` | outbound links in the text; a reddit link post's target is included |
| `quoted` | the quoted post (x, bluesky) or the crosspost original (reddit), one level deep, or null |
| `parent` | `{ id, url, author }` of what this replies to, or null |
| `stats` | `{ likes, reposts, replies, score, views }`, each a number or null when the source has no such thing |
| `flags` | `{ nsfw, spoiler, edited }` |
| `extra` | source fields that do not fit above (next table) |

a `Comment` is a `Post` plus `depth` (0 at the top of the tree) and `replies: Comment[]`.

### `extra` by source

| source | fields |
| --- | --- |
| reddit post | `subreddit`, `flair`, `upvoteRatio`, `removed`, `poll: { options: [{ text, votes }], totalVotes }` |
| reddit comment | `op`, `distinguished`, `stickied`, `awards` |
| twitter | `lang`, `quotes`, `poll: { options: [{ text, votes }], endsAt }`, `cardImage` (a link card's large image), `communityNote` |
| bluesky | `lang`, `quotes` |
| instagram | `kind`: `photo`, `video` or `carousel` |
| threads | `kind` as on instagram, `quotes` |
| tiktok | `kind`: `video` or `photo`; `music: { title, author }` when the page has it |
| booru | `site`, `tags`, `rating` (`safe`, `questionable` or `explicit`), `score`, `favorites`, `source`, `md5`, `fileSize`, `width`, `height`, `uploaderId` |
| pinterest | none |
| list | `kind`: `video` or `audio`; `total`; `entries: [{ url, title, artist, duration }]`; the page fields too when the list's page could be read |
| video | `site`, `duration`, `tags`, `categories`, `chapters: [{ title, start }]`, `liveStatus`, `followers`, `transcript` when asked for |
| page | `site`, `type`, `language`, `description`, `modifiedAt`, `duration`, `tags` |

- booru `tags` are grouped by kind: `artist`, `character`, `copyright`, `general`, `meta`, and on
  e621 also `species` and `lore`. yande.re and konachan put every tag under `general`.
- list `entries` holds up to 100, in order; `duration` is in seconds and `artist` is the channel for
  a video. `total` is how many the source says the list has, or how many came back when it does not
  say.
- page `description` is only set when `text` is the article body, so it is never a copy of `text`.
  a direct file link (by its extension) is answered with that one media item and only `site` and
  `type: "file"`, without fetching it.
- `extra.transcript` on a youtube post asked for with `transcript` is
  `{ language, generated, segments: [{ start, end, text }] }`, times in seconds. uploaded captions
  win over youtube's automatic ones (`generated: true`); null when the video has no captions in that
  language.

### `format: "text"`

one block per post, the thread in order, then the comment tree indented four spaces per level,
quotes prefixed with `> `. a list prints its entries as numbered lines, a transcript prints as
`[mm:ss] text` lines, and a truncated answer ends with `(truncated)`. meant for pasting into a
prompt or a terminal, not for parsing: parse the json.

```
reddit: https://www.reddit.com/r/pics/comments/abc123/title/

# dog photo shoot
@photographer · 2026-09-30 12:00
took these yesterday
[image] https://i.redd.it/abc.jpg

--- comments ---

@someone · 2026-09-30 12:10
good dog

    @photographer · 2026-09-30 12:12
    thanks
```

```
list: https://open.spotify.com/album/<id>

# songs for penguins
unknown (the penguins)
an album by the penguins.
1. the penguins - ice (03:12) https://open.spotify.com/track/<id>
2. the penguins - fish (04:05) https://open.spotify.com/track/<id>
```

### errors

the usual `{ "error": { "code", "message" } }`, with the http status set. the message is always
safe to show to a person.

| status | code | when |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | not json, no `url`, or an option out of range |
| 413 | `BAD_REQUEST` | the body is over 16 kb |
| 400 | `BAD_URL` | not a link, a private address, or a link the reader can't use (one that answers with something other than an html or xml page) |
| 401 | `UNAUTHORIZED` | the api key is not valid |
| 403 | `VERIFICATION_FAILED` | no api key and the turnstile token did not verify |
| 404 | `CONTENT_GONE` | deleted, removed, private, or the page is gone |
| 429 | `RATE_LIMITED` | over quota; `retryAfter` says how long |
| 502 | `NETWORK_ERROR` | the source refused or timed out |
| 502 | `NO_SESSION` | instagram, with no session to read it |
| 502 | `CONTENT_FAILED` | anything else; the raw error only goes to the log |

a reader can also answer with a more specific code of its own, such as `TIMED_OUT` or `GEO_BLOCKED`
from a video site.

## how each source is read

the code lives in `src/content/`: `schema.js` is the shape and the text renderer, one file per
source, and `index.js` is the registry (`CONTENT_SOURCES`) that `/v1/content` routes through. a
source is a row with `match(url)` and `fetch(url, options) -> Thread`.

### reddit (`src/content/reddit.js`)

reddit's own `.json` listing behind the permalink, the same call `/download` makes, read with a
reddit session. the listing carries the post and the comment tree in one response; anything reddit
folds into a `more` stub is left out and marks the answer `truncated`. a comment permalink makes
that comment the `post` and its replies the tree.

not done yet: following `more` stubs to fill out big threads, and a sort order.

### x (`src/content/twitter.js`)

x's own web api (graphql), the same calls x.com makes in a browser. the post is read as a
logged-out guest, so most reads use no account; posts x hides from guests are read again with a
session. one call gives the post, its author, stats, media (best mp4 for video, original-size
images), long-post and article text, poll, community note, the quoted post, and the post it
replies to.

threads are rebuilt upward: while the parent is by the same author, read it and prepend, up to 25
posts or 40 seconds. replies need a session and are off unless `comments` is set; they come from
one page of the conversation view, which also returns the author's own follow-ups below the post,
so a thread is completed downward when replies are asked for.

query ids change when x ships a new web build. gronka carries the current ones and, when x rejects
one, reads the fresh ids from x.com's bundle and retries once.

### other sources

- bluesky (`src/content/bluesky.js`): bluesky's public api. one call gives the post, the author's
  thread above it (up to 25 posts) and below it, and replies, each with its own direct replies. no
  account.
- instagram (`src/content/instagram.js`): the same signed-in media info call the downloader makes,
  one per read; caption, author, likes, comment count, views, media. no replies.
- threads (`src/content/threads.js`): the post's own page, no account. a threads post carries the
  same fields as an instagram one, plus reposts and quotes. no replies.
- tiktok (`src/content/tiktok.js`): the data embedded in tiktok's own page, or tiktok's oembed when
  the page has none; caption, author, stats, cover, video, music. no replies.
- booru (`src/content/booru.js`): each site's json api, the same call the downloader makes; tags,
  rating, score, favorites, source link, the original file.
- pinterest (`src/content/pinterest.js`): the pin page's own embedded data; title, description,
  pinner, the image or video, likes, and comment count and views on video pins.
- lists (`src/content/list.js`): the same listing `/download` uses, up to 100 entries, with the
  list's page read like any other page for its title, cover and description. when the page can't
  be read, the listing alone answers.
- video sites (`src/content/video.js`): yt-dlp reads the metadata with no download; title,
  description, channel, stats, thumbnail, tags, chapters. replies and captions only on youtube.
- pages (`src/content/page.js`): the page's html, read as markup with nothing on it run. the title,
  author, date, images and tags come from its meta tags (opengraph, twitter and the plain ones),
  json-ld and `<title>`. the text is the json-ld `articleBody`, else the paragraphs in `article`,
  else those in `main`, else the description, cut at 20000 characters.
