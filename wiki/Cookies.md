Some sites only serve media to a logged-in session. gronka reads those from `cookies.json`, the
same way cobalt does — you write the file, there is no magic.

**Everything here is optional.** Without any cookies the bot still downloads from every source
that does not gate its content, which is most of them.

## The format

One entry per service. The value is the `Cookie:` header your browser would send — `name=value`
pairs joined by `; `:

```json
{
  "instagram": ["mid=…; ig_did=…; csrftoken=…; ds_user_id=…; sessionid=…"],
  "reddit": ["reddit_session=…"],
  "twitter": ["auth_token=…; ct0=…"]
}
```

Copy `cookies.example.json` to `cookies.json` and fill in the placeholders. Delete any service you
do not use — an absent service is not an error.

## Getting the values

Either way, log into the site in a normal browser tab first.

**From DevTools** — no extensions, works everywhere:

1. F12 → **Application** → **Storage** → **Cookies** → the site's entry.
2. Copy the value of each cookie named below into the string.

**From an export** — easier when you need several:
[Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
exports the current site's cookies as a Netscape `cookies.txt`. Each line is tab-separated and the
last two columns are the name and value:

```
.instagram.com   TRUE   /   TRUE   1804893724   sessionid   56293383463%3Aag5…
                                                 ^^^^^^^^^   ^^^^^^^^^^^^^^^^^
```

Take the pairs you need and join them with `; ` into the one-line string above. There is
deliberately no importer for this — see *Why it is manual*.

> That extension reads every cookie for the site you are on, and it is third-party. It runs
> locally and does not upload anything, which is the point of the "LOCALLY" fork, but export only
> the site you actually need and do not paste a full export anywhere.

### yt-dlp is the exception

`tiktok-cookies.txt` wants the Netscape format **exactly as exported** — no reshaping. Export from
TikTok, save it as `tiktok-cookies.txt` in the project root, done. It is only needed for
age-restricted TikTok posts; leave the file empty otherwise (it still has to exist, or docker
mounts a directory over it).

## What each service needs

| Service | Cookies | Effect |
|---|---|---|
| **instagram** | `sessionid` **(required)**, plus `mid`, `ig_did`, `csrftoken`, `ds_user_id` | Photo and carousel posts work at all. Without a session these fail, because cobalt and yt-dlp can only return video from an Instagram post. |
| **reddit** | `reddit_session` (optional) | Galleries return every slide instead of the first. Everything else already works anonymously through the post's Atom feed. |
| **twitter** | `auth_token`, `ct0` (optional) | Lets cobalt reach gated or age-restricted posts. |

Reddit's `client_id` / `client_secret` / `refresh_token` are **not** cookies and do not belong
here. Those are for cobalt's OAuth path, which needs a Reddit-approved API app — approval Reddit
no longer grants for new apps, which is why gronka reads the feed instead.

## Two files, on purpose

| File | Who reads it | Mount |
|---|---|---|
| `cookies.json` | the bot | read-only |
| `cobalt-cookies.json` | cobalt | read-write |

They start as identical copies. Cobalt **rewrites its own file** and drops any service it does not
recognise, so sharing one file between them silently deletes entries — which is exactly what
happened before they were split. Put your cookies in both; only `cookies.json` matters for the
bot's own Instagram and Reddit extractors.

## Checking it worked

```bash
bun run setup:check
```

prints which cookies each service has and names any required one that is missing. It never prints
values.

In the logs, a dead session is explicit rather than mysterious:

```
Instagram rejected the session cookie (HTTP 302) — the sessionid in the cookie file needs refreshing
Reddit refused the session cookie (HTTP 429) — the reddit_session in the cookie file needs refreshing
```

If you see those, the session expired: repeat the steps above. The bot does not need rebuilding —
the file is re-read per request — but cobalt caches its copy, so `docker restart cobalt` after
updating `cobalt-cookies.json`.

## Keep it private

`cookies.json` holds live logins. Anyone who reads the file is signed in as you.

- Keep it `chmod 600`. It is gitignored, and so is `cobalt-cookies.json` — keep it that way.
- Use a throwaway account if you can. A bot making steady API calls from one datacenter IP can get
  an account flagged for automation, and a session that only ever hits an API endpoint and never
  browses is the obvious shape of that.
- Copy only the cookies listed above. A full browser cookie export contains every site you are
  logged into.

## Why it is manual

Because the alternative is worse. An importer that accepts four paste formats is a lot of code
guarding one documented file, and it still cannot tell you whether the session actually works —
only the site can. Cobalt reached the same conclusion: write the file, and the tooling tells you
what is missing.
