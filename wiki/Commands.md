all available commands and context menu options in gronka.

## message commands

every slash command also works as a message: mention the bot, then the command. gronka doesn't use discord's message content intent, so in a server it only sees messages that mention it. in dms the prefix `^g` (`COMMAND_PREFIX`) works too.

```
@gronka download https://twitter.com/user/status/123
@gronka convert https://example.com/video.mp4 start=0:05 end=0:10
@gronka optimize lossy=50        (with a gif attached)
@gronka info
@gronka help
^g download https://twitter.com/user/status/123        (dms only)
```

**usage:**

- options go after the command as `key=value` pairs: `optimize`, `lossy`, `start`, `end`, `format`, `mp3`
- `convert` and `optimize` take a url or an attachment on your message (in dms, also one on the message you reply to)
- a bare mention shows a short prompt; `help` shows commands and options
- unknown commands after a mention get a pointer to help; unknown commands after the dm prefix are ignored

## slash commands

### `/convert`

convert a video or image to gif.

**parameters:**

- `file` (attachment, optional) - the video or image file to convert
- `url` (string, optional) - url to a video or image file to convert
- `format` (choice, optional) - what to convert to: GIF (default), MP4 or WebM video, MP3, M4A, OGG, WAV or FLAC audio, or a PNG, JPG or WebP image. the input type is detected, never chosen. audio needs a video with sound, still images can only become images, and a gif can also become MP4 or WebM. `optimize` and `lossy` only apply to gif output
- `optimize` (boolean, optional) - optimize the gif after conversion to reduce file size
- `lossy` (number, optional) - lossy compression level (0-100, default: 35)
- `start` (string, optional) - start time for trimming video before conversion, as seconds (`90`, `12.5`) or a timestamp (`3:10`, `1:02:30`) (only applies to video inputs, ignored for images)
- `end` (string, optional) - end time for trimming video before conversion, as seconds (`90`, `12.5`) or a timestamp (`3:10`, `1:02:30`) (only applies to video inputs, ignored for images)

**usage:**

- provide either a file attachment or a url (or both)
- if both are provided, the file attachment takes precedence
- the `optimize` flag applies lossy compression after conversion
- **for videos**: time parameters (`start`, `end`) trim the video first, then convert to gif
  - if only `start` is provided, conversion starts at that time and continues to end of video
  - if only `end` is provided, conversion starts at beginning and ends at that time
  - if both are provided, conversion uses the specified range
  - `end` must be greater than `start` if both are provided
- **for images**: time parameters are ignored (images don't have a time dimension)

**examples:**

```
/convert file:<attach video>
/convert url:https://example.com/video.mp4
/convert file:<attach image> optimize:true
/convert url:https://example.com/video.mp4 start:30 end:60
/convert url:https://example.com/video.mp4 start:1:30 end:3:10
/convert file:<attach video> start:10
```

### `/download`

download media from a social media url or direct url.

**parameters:**

- `url` (string, required) - url to download media from
- `start` (string, optional) - start time for video trimming, as seconds (`90`, `12.5`) or a timestamp (`3:10`, `1:02:30`) (only applies to videos, ignored for images/gifs)
- `end` (string, optional) - end time for video trimming, as seconds (`90`, `12.5`) or a timestamp (`3:10`, `1:02:30`) (only applies to videos, ignored for images/gifs)
- `mp3` (boolean, optional) - send just the audio as an mp3 instead of the video. works with any source that has sound, and respects `start`/`end`

**usage:**

- works with social media platforms (twitter, tiktok, instagram, etc.) if cobalt is enabled
- also works with direct media urls
- embed-fixer mirror urls are rewritten to the canonical site before downloading: fxtwitter.com, fixupx.com, twittpr.com, pxtwitter.com, vxtwitter.com, fixvx.com, cunnyx.com, girlcockx.com, and stupidpenisx.com all map to twitter.com; fxbsky.app maps to bsky.app
- youtube downloads are handled by yt-dlp and capped by the max video duration setting; use `start`/`end` to grab a clip from a longer video (trimmed downloads bypass the duration cap)
- age-restricted tiktok posts fall back from cobalt to yt-dlp, which needs a cookies file, see `YTDLP_COOKIES_PATH` in [[Configuration]]
- downloads the media without conversion; nothing is kept once it is delivered
- **for videos**: time parameters (`start`, `end`) trim the video before saving
  - if only `start` is provided, video is trimmed from that time to the end
  - if only `end` is provided, video is trimmed from beginning to that time
  - if both are provided, video is trimmed to the specified range
  - `end` must be greater than `start` if both are provided
- **for images/gifs**: time parameters are ignored (images/gifs don't have a time dimension)
- use `/convert` afterwards if you want to convert to gif
- **url-only mode**: when enabled from the webui settings page, `/download` replies with the direct media url from cobalt (e.g. video.twimg.com) instead of downloading and re-uploading the file. trim requests (`start`/`end`) and youtube urls (handled by yt-dlp) still use the normal download pipeline, as does any url where cobalt only offers a tunnel response

**examples:**

```
/download url:https://twitter.com/user/status/123
/download url:https://example.com/video.mp4
/download url:https://example.com/video.mp4 start:30 end:60
/download url:https://example.com/video.mp4 start:1:30 end:3:10
/download url:https://example.com/video.mp4 start:10
```

### `/optimize`

optimize an existing gif to reduce file size.

**parameters:**

- `file` (attachment, optional) - the gif file to optimize
- `url` (string, optional) - url to a gif file to optimize
- `lossy` (integer, optional) - lossy compression level (0-100, default: 35)

**usage:**

- provide either a file attachment or a url
- `lossy` level controls compression:
  - 0-30: minimal compression, highest quality, larger files
  - 30-60: balanced compression and quality (default: 35)
  - 60-100: maximum compression, lower quality, smaller files

**examples:**

```
/optimize file:<attach gif>
/optimize url:https://example.com/gif.gif lossy:50
```

### `/info`

view usage, storage, and system information in one embed.

**parameters:** none

**usage:**

- **usage**, uptime, guild count, unique user count
- **storage**, files stored (gifs, videos, images), disk usage, and r2 usage against its
  limit with the cache age
- **system**, platform, cpu count, memory, bun and gronka versions

**examples:**

```
/info
```

## context menu commands

context menu commands are available by right-clicking on a message in discord.

### convert to gif

convert media from a message to gif.

**usage:**

1. right-click on a message containing a video or image
2. select "apps" → "convert to gif"
3. the bot will convert the media and reply with a gif link

**notes:**

- works with message attachments
- also works with media urls in the message content
- automatically detects video or image format

### download

download media from a message.

**usage:**

1. right-click on a message containing a url
2. select "apps" → "download"
3. the bot will download the media and reply with a link

**notes:**

- works with social media urls if cobalt is enabled
- also works with direct media urls
- downloads without conversion

### optimize

optimize a gif from a message.

**usage:**

1. right-click on a message containing a gif
2. select "apps" → "optimize"
3. a modal will appear to enter the lossy level (0-100)
4. the bot will optimize the gif and reply with a link

**notes:**

- only works with gif files
- lossy level can be customized via the modal

## file size limits

default file size limits:

- videos: 100mb maximum for downloads and conversions (configurable via `MAX_VIDEO_SIZE`)
- images: 50mb maximum (configurable via `MAX_IMAGE_SIZE`)
- gif optimization: 50mb maximum
- gif duration: 30 seconds maximum (configurable via `MAX_GIF_DURATION`)
- video length: the max video duration setting (trimmed downloads via `start`/`end` bypass this)

## error messages

common error messages and what they mean:

- "file too large" - the file exceeds size limits
- "unsupported format" - the file type isn't supported
- "download failed" - the download couldn't complete (check url or cobalt status)
- "video duration exceeds the maximum allowed (5 minutes)" - the video is over the youtube duration cap; use `start`/`end` to download a clip under the limit
- "conversion failed" - ffmpeg couldn't process the file
