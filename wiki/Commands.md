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

- options go after the command as `key=value` pairs: `optimize`, `lossy`, `start`, `end`, `format`
- `convert` and `optimize` take a url or an attachment on your message (in dms, also one on the message you reply to)
- a bare mention shows a short prompt; `help` shows commands and options
- unknown commands after a mention get a pointer to help; unknown commands after the dm prefix are ignored

## slash commands

### `/convert`

convert video, audio or images to a compatible format.

**parameters:**

- `file` (attachment, optional) - the video, audio or image file to convert
- `link` (string, optional) - a media file or supported social media link
- `format` (choice, optional) - omit it to choose from compatible formats, or select GIF, MP4, WebM, MP3, M4A, OGG, WAV, FLAC, PNG, JPG or WebP directly
- `optimize` (boolean, optional) - optimize GIF output to reduce its size
- `lossy` (number, optional) - GIF output only, compression level from 0 to 100 (default: 35)
- `start` and `end` (strings, optional) - trim video, audio or animation, using seconds (`90`, `12.5`) or a timestamp (`3:10`, `1:02:30`)

**usage:**

1. provide a file or link; when both are supplied, the file takes precedence. with neither, a form opens to upload a file or paste a link
2. without `format`, choose a compatible output from the picker
3. the converted file is posted to chat, or delivered as a link when it exceeds the attachment limit

slash-command and context-menu pickers are private. message-command pickers appear in chat and only the person who invoked the command can use them. a picker expires after five minutes or can be cancelled. temporary files are removed when the request finishes, expires or is cancelled.

| input | available outputs |
| --- | --- |
| video | GIF, MP4, WebM; PNG, JPG and WebP still frames; audio formats when the source has sound |
| audio | MP3, M4A, OGG, WAV, FLAC |
| GIF or animated WebP | GIF, MP4, WebM; PNG, JPG and WebP still frames |
| still image | PNG, JPG, WebP, GIF |

audio files with embedded artwork are treated as audio. multiple audio tracks use the marked default, or the first track when none is marked. same-format choices are allowed and use the normal conversion preset; GIF can also be copied or optimized. choosing FLAC or WAV cannot restore detail already lost to compression. GIF has no sound, JPG has no transparency, and still-image outputs contain one frame rather than the whole animation.

`start` alone converts from that point to the end; `end` alone converts from the beginning. `end` must be after `start` and the range must fit the source. still images reject timestamps. a still frame is extracted at `start`, or at the beginning when `start` is omitted. `optimize` and `lossy` affect GIF output only.

**examples:**

```
/convert file:<attach video>                  (choose an output, including GIF)
/convert file:<attach audio> format:mp3
/convert link:https://example.com/video.mp4 format:gif start:30 end:60
/convert file:<attach image> format:webp
```

### `/download`

download media from a social media link or direct file link.

**parameters:**

- `link` (string, required) - link to download media from
- `start` (string, optional) - start time for video trimming, as seconds (`90`, `12.5`) or a timestamp (`3:10`, `1:02:30`) (only applies to videos, ignored for images/gifs)
- `end` (string, optional) - end time for video trimming, as seconds (`90`, `12.5`) or a timestamp (`3:10`, `1:02:30`) (only applies to videos, ignored for images/gifs)

**usage:**

- works with social media platforms (twitter, tiktok, instagram, etc.) if cobalt is enabled
- also works with direct media urls
- embed-fixer mirror urls are rewritten to the canonical site before downloading: fxtwitter.com, fixupx.com, twittpr.com, pxtwitter.com, vxtwitter.com, fixvx.com, cunnyx.com, girlcockx.com, and stupidpenisx.com all map to twitter.com; fxbsky.app maps to bsky.app
- youtube downloads are handled by yt-dlp; a video over the size limit can still be grabbed as a clip with `start`/`end`. live streams are refused until they end
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
/download link:https://twitter.com/user/status/123
/download link:https://example.com/video.mp4
/download link:https://example.com/video.mp4 start:30 end:60
/download link:https://example.com/video.mp4 start:1:30 end:3:10
/download link:https://example.com/video.mp4 start:10
```

### `/optimize`

optimize an existing gif to reduce file size.

**parameters:**

- `file` (attachment, optional) - the gif file to optimize
- `link` (string, optional) - link to a gif file to optimize
- `lossy` (integer, optional) - lossy compression level (0-100, default: 35)

**usage:**

- provide either a file attachment or a link; with neither, a form opens to upload a gif or paste a link
- `lossy` level controls compression:
  - 0-30: minimal compression, highest quality, larger files
  - 30-60: balanced compression and quality (default: 35)
  - 60-100: maximum compression, lower quality, smaller files

**examples:**

```
/optimize file:<attach gif>
/optimize link:https://example.com/gif.gif lossy:50
```

### `/info`

bot version, memory, uptime and queue status in one embed.

**parameters:** none

**shows:**

- **version**, the running gronka release
- **memory**, the bot process and, with media workers on, the total across the bot and every live worker
- **uptime**, since the bot started and since it connected to discord
- **queue**, running or paused, with running and waiting job counts
- **host**, platform and cpu count
- **runtime**, bun and discord.js versions
- **servers**, how many servers the bot is in
- links to the support server (when `SUPPORT_INVITE_URL` is set) and the source code

**examples:**

```
/info
```

## context menu commands

context menu commands are available by right-clicking on a message in discord.

### convert

convert media from a message to a compatible format.

1. right-click a message containing video, audio, an image or a media link
2. select "apps" → "convert"
3. open the dropdown in the private reply and choose an output format
4. the converted file is posted to chat, or delivered as a link

attachments take precedence over links. a message with neither opens a form to upload a file or paste a link. if a message contains several attachments, the first supported media file is used and its filename is shown in the picker. embeds and forwarded attachments are supported. conversion processes one media file per request; social media galleries use the first item.

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
- a message with no link but a video, audio or image file gets a button to convert that file instead

### optimize

optimize a gif from a message.

**usage:**

1. right-click on a message containing a gif
2. select "apps" → "optimize"
3. a modal will appear to enter the lossy level (0-100)
4. the bot will optimize the gif and reply with a link

**notes:**

- only works with gif files; a message without one opens a form to upload a gif or paste a link
- lossy level can be customized via the modal

## file size limits

one size limit covers every file the bot downloads, converts or optimizes: 1gb by default, set by the max download size webui setting (`MAX_VIDEO_SIZE` when it is unset). files over the discord attachment limit are sent as [[R2-Storage]] links.

## error messages

common error messages and what they mean:

- "file too large" - the file exceeds size limits
- "unsupported format" - the file type isn't supported
- "download failed" - the download couldn't complete (check url or cobalt status)
- "this file is over the 1024MB limit" - the file is bigger than the size limit; for a video, use `start`/`end` to download a clip under it
- "conversion failed" - ffmpeg couldn't process the file
