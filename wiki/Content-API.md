# content api

`POST /v1/content` on api.gronka.dev reads the text behind a link instead of the file: a reddit
post with its comment tree, or an x post with the post it quotes and the author's own thread. the
answer is one json shape whatever the source, so a script, a bot or a prompt parses it the same
way. this page is the design sketch and the roadmap; the live reference is
[openapi.json](https://web.gronka.dev/openapi.json) and the [docs page](https://web.gronka.dev/docs/#content).

status: sketch. reddit and x are wired; the shape may still move before it leaves preview.

## request

```bash
curl https://api.gronka.dev/v1/content \
  -H 'Authorization: Bearer <key>' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.reddit.com/r/pics/comments/abc123/title/","depth":3,"comments":100}'
```

| field      | type                 | default | applies to | what it does                                                      |
| ---------- | -------------------- | ------- | ---------- | ----------------------------------------------------------------- |
| `url`      | string               |         | all        | a link, or text with a link in it. share links and mirrors work    |
| `format`   | `json` \| `text`     | `json`  | all        | `text` renders the same content as plain text (see below)          |
| `thread`   | boolean              | `true`  | x          | walk the author's replies upward from the linked post              |
| `depth`    | integer 0..10        | 10      | reddit     | comment levels to include; `0` leaves the comments out            |
| `comments` | integer 0..500       | 500     | reddit     | cap on comments across the whole tree                              |

auth, quota and turnstile are the same as `/v1/download`: an api key or the web page's turnstile
token, 50 requests per 10 minutes per caller, and the quota is shared between downloads and
content reads. unlike downloads the answer is not padded: a read takes seconds, so the http status
carries the outcome.

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

- `source`: `reddit` or `twitter`.
- `url`: the canonical link after share-link and mirror rewriting (`/s/` on reddit, fxtwitter and
  friends on x).
- `post`: the item the link points at.
- `thread`: the author's own continuation in order, the post included. x only; empty when the post
  stands alone.
- `comments`: replies by other people, as a tree. reddit only; always empty for x, which is on
  purpose: x replies are mostly noise and cost a session to read.
- `truncated`: true when `depth`, `comments`, the thread cap (25 posts) or a deleted parent dropped
  something.

### `Post`

| field       | notes                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| `id`, `url` | the source's id and a canonical permalink                                               |
| `author`    | `{ handle, name, url }`; `handle` is the `@name` or `u/name` without the prefix, null when deleted |
| `createdAt` | iso 8601 utc, or null                                                                   |
| `title`     | reddit post title, null elsewhere                                                       |
| `text`      | the body as plain text. reddit markdown is left as written, x gives the full note or article text |
| `media`     | `[{ type: image \| video \| gif, url, alt, width, height }]` in the order posted          |
| `links`     | outbound links in the text; a reddit link post's target and an x card link are included, `t.co` wrappers are not |
| `quoted`    | the quoted post or the crosspost original, one level deep, or null                       |
| `parent`    | `{ id, url, author }` of what this replies to, or null                                   |
| `stats`     | `{ likes, reposts, replies, score, views }`, each a number or null when the source has no such thing |
| `flags`     | `{ nsfw, spoiler, edited }`                                                              |
| `extra`     | source-specific leftovers: reddit `subreddit`, `flair`, `upvoteRatio`, `poll`, `removed`; x `lang`, `source`, `poll`, `article`, `communityNote`; comments `op`, `distinguished`, `stickied`, `awards` |

a `Comment` is a `Post` plus `depth` (0 at the top of the tree) and `replies: Comment[]`.

### `format: "text"`

one block per post, the thread in order, then the comment tree indented four spaces per level,
quotes prefixed with `> `. meant for pasting into a prompt or a terminal, not for parsing: parse
the json.

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

### errors

the usual `{ "error": { "code", "message" } }`, with the http status set:

| status | code                 | when                                                   |
| ------ | -------------------- | ------------------------------------------------------ |
| 400    | `BAD_URL`            | not a link, or a private address                       |
| 400    | `UNSUPPORTED_SOURCE` | a site the content api does not read (yet)             |
| 404    | `CONTENT_GONE`       | deleted, removed, private, or age-gated                |
| 429    | `RATE_LIMITED`       | over quota; `retryAfter` says how long                 |
| 502    | `NETWORK_ERROR`      | the source refused or timed out (curated message)      |
| 502    | `CONTENT_FAILED`     | anything else; the raw error only goes to the log      |

## how each source is read

the code lives in `src/content/`: `schema.js` is the shape and the text renderer, one file per
source, and `index.js` is the registry (`CONTENT_SOURCES`) that `/v1/content` routes through. a
source is a row with `match(url)` and `fetch(url, options) -> Thread`.

### reddit (`src/content/reddit.js`)

reddit's own `.json` listing behind any post permalink, the same call `/download` already makes,
with the `reddit_session` cookie from `cookies.json` because anonymous requests are 403. the
listing carries the post and the comment tree in one response (up to `limit=100` top-level
comments; deeper branches arrive inline, and anything reddit folds into a `more` stub marks the
answer `truncated`). a comment permalink makes that comment the `post` and its replies the tree,
mirroring what the downloader does with a comment link.

not done yet: following `more` stubs (`/api/morechildren`) to fill out big threads, and `sort`
(`top`, `new`, `controversial`), which the listing accepts as a query parameter.

### x (`src/content/twitter.js`)

[fxtwitter's](https://github.com/FxEmbed/FxEmbed) public json api (`api.fxtwitter.com/i/status/<id>`),
no cookies. one call gives the post, its author, media, poll, article text, community note, the
quoted post, and the id and author of the post it replies to. that last pair is how threads are
rebuilt: while the parent is by the same author, fetch it and prepend, up to 25 posts or 40
seconds. so a link to the *last* post of a thread returns the whole thread; a link to the *first*
returns that post alone, because nothing public says what comes after it.

the way to also walk *down* (and to read replies, if ever wanted) is x's graphql `TweetDetail`
with the `auth_token` and `ct0` cookies that `cookies.json` already holds for cobalt. it returns
the conversation with the author's self-replies in a `conversationthread` module. the cost is a
query id that rotates with x's web bundle and a session that x may flag, which is why it is the
second step and not the first. gallery-dl's twitter extractor is the reference implementation if
we go there.

## other sites worth adding

ordered by how cheap they are. "free api" means a public json endpoint with no key and no login,
which is the only kind that stays working.

| site                    | how                                                                                                              | gets                                             | cost  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----- |
| bluesky                 | `public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://...` (resolve the handle with `resolveHandle`)   | full thread, replies, quotes as embeds, media    | free api, an afternoon |
| mastodon / fediverse    | `/api/v1/statuses/:id` and `/context` on the post's own instance                                                 | post, ancestors, descendants, media, polls       | free api; any instance, so the ssrf guard matters |
| hacker news             | `hacker-news.firebaseio.com/v0/item/:id.json` or algolia `hn.algolia.com/api/v1/items/:id` (whole tree in one call) | story, comment tree, scores                       | free api |
| lemmy / kbin            | `/api/v3/post?id=` and `/api/v3/comment/list?post_id=` on the instance                                            | reddit-shaped post and tree                       | free api |
| 4chan                   | `a.4cdn.org/:board/thread/:no.json`                                                                              | whole thread with media on `i.4cdn.org`           | free api |
| youtube                 | yt-dlp `--dump-json` (already in the image) for title, description, chapters; `--write-comments` for comments    | description text and comments                     | already have yt-dlp; comments are slow |
| tiktok                  | the caption and author are in the cobalt/yt-dlp metadata we already fetch for the download                       | caption, hashtags                                 | small, no new fetch |
| instagram               | the media-info api `src/utils/instagram.js` already calls with the session cookie carries the caption and comments preview | caption, first comments                 | cookie we already have |
| tumblr                  | `api.tumblr.com/v2/blog/:blog/posts/:id?npf=true` with a free api key                                             | post blocks, reblog trail, tags                   | needs a key in env |
| threads (meta)          | no api without an app review; the page html embeds the post json                                                 | post, replies                                     | scraping, breaks often |
| facebook                | same as threads, worse                                                                                           |                                                   | skip  |
| articles (substack, medium, news) | readability over the fetched html, or the site's rss                                                   | title, body text                                  | generic; a different shape (`article`, not `Thread`) |

the first three are the ones to do next: bluesky and mastodon slot into `Thread` without changing
it (replies become `comments`, embeds become `quoted`), and hacker news is the cleanest "thread"
there is.

## open questions

- `GET /v1/content?url=` as an alias for the json shape. cacheable and easy to paste in a browser,
  but the turnstile flow and the body options do not fit a query string. the download endpoint
  settled on POST, so this does too, for now.
- caching. a thread does not change much in ten minutes and the same link gets pasted many times.
  an in-memory lru keyed on the canonical url with a short ttl would cut the source calls without
  keeping anything on disk, which fits the no-logs promise.
- x replies. not planned: they need a session and they are the part people least want. if ever,
  `replies: true` as an option, off by default.
- a `/v1/content` box on web.gronka.dev. the api comes first; a page that shows a thread as text
  with a copy button is a small follow-up.
