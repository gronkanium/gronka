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
  -d '{"url":"https://www.reddit.com/r/pics/comments/abc123/title/","depth":3,"comments":10}'
```

| field      | type                 | default | applies to | what it does                                                      |
| ---------- | -------------------- | ------- | ---------- | ----------------------------------------------------------------- |
| `url`      | string               |         | all        | a link, or text with a link in it. share links and mirrors work    |
| `format`   | `json` \| `text`     | `json`  | all        | `text` renders the same content as plain text (see below)          |
| `thread`   | boolean              | `true`  | x          | walk the author's replies upward from the linked post              |
| `depth`    | integer 0..10        | 10      | reddit     | comment levels to include; `0` leaves the comments out            |
| `comments` | integer 0..20        | 0       | reddit, x  | replies to include; off unless set                                 |

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
- `url`: the canonical link after share-link and mirror rewriting (`/s/` on reddit, embed mirrors and
  friends on x).
- `post`: the item the link points at.
- `thread`: the author's own continuation in order, the post included. x only; empty when the post
  stands alone.
- `comments`: replies by other people, as a tree; empty unless `comments` is set, and never more
  than 20. a sample, not the whole conversation.
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

x's own web api (graphql), the same calls x.com makes in a browser. the post is read as a
logged-out guest (`TweetResultByRestId` with a guest token), so most reads use no account. posts x
hides from guests (age-gated, sensitive) are read again with the session cookie in `cookies.json`.
one call gives the post, its author, stats, media (best mp4 for video, original-size images),
long-post and article text, poll, community note, the quoted post, and the post it replies to.

threads are rebuilt upward: while the parent is by the same author, read it and prepend, up to 25
posts or 40 seconds. replies are off unless `comments` is set (at most 20); they come from the
logged-in conversation view (`TweetDetail`, one page), which also returns the author's own
follow-ups below the post, so a thread is completed downward when replies are asked for.

query ids change when x ships a new web build. gronka carries the current ones and, when x
rejects one, reads the fresh ids from x.com's bundle and retries once. the session is touched only
for hidden posts and replies, to keep the account quiet.