all available commands and context menu options in gronka.

## slash commands

### `/convert`

convert a video or image to gif.

**parameters:**

- `file` (attachment, optional) - the video or image file to convert
- `url` (string, optional) - url to a video or image file to convert
- `optimize` (boolean, optional) - optimize the gif after conversion to reduce file size
- `lossy` (number, optional) - lossy compression level (0-100, default: 35)
- `start_time` (number, optional) - start time in seconds for trimming video before conversion (only applies to video inputs, ignored for images)
- `end_time` (number, optional) - end time in seconds for trimming video before conversion (only applies to video inputs, ignored for images)

**usage:**

- provide either a file attachment or a url (or both)
- if both are provided, the file attachment takes precedence
- the `optimize` flag applies lossy compression after conversion
- **for videos**: time parameters (`start_time`, `end_time`) trim the video first, then convert to gif
  - if only `start_time` is provided, conversion starts at that time and continues to end of video
  - if only `end_time` is provided, conversion starts at beginning and ends at that time
  - if both are provided, conversion uses the specified range
  - `end_time` must be greater than `start_time` if both are provided
- **for images**: time parameters are ignored (images don't have a time dimension)

**examples:**

```
/convert file:<attach video>
/convert url:https://example.com/video.mp4
/convert file:<attach image> optimize:true
/convert url:https://example.com/video.mp4 start_time:30 end_time:60
/convert file:<attach video> start_time:10
```

### `/download`

download media from a social media url or direct url.

**parameters:**

- `url` (string, required) - url to download media from
- `start_time` (number, optional) - start time in seconds (accepted but not used for downloads)
- `end_time` (number, optional) - end time in seconds (accepted but not used for downloads)

**usage:**

- works with social media platforms (twitter, tiktok, instagram, etc.) if cobalt is enabled
- also works with direct media urls
- downloads and stores the media without conversion
- use `/convert` afterwards if you want to convert to gif
- time parameters are accepted for consistency but are not used for downloads (use `/convert` for video trimming)

**examples:**

```
/download url:https://twitter.com/user/status/123
/download url:https://example.com/video.mp4
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

### `/stats`

view storage statistics.

**parameters:** none

**usage:**

- shows total files stored (gifs, videos, images)
- displays storage usage
- shows bot uptime
- requires authentication if `STATS_USERNAME` and `STATS_PASSWORD` are configured

**examples:**

```
/stats
```

### `/info`

view bot information and configuration.

**parameters:** none

**usage:**

- displays bot version and status
- shows configured storage type (r2 or local)
- shows enabled features

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
- optimized gifs are stored separately from originals

## rate limiting

commands are rate limited to prevent abuse:

- 30-second cooldown between commands per user
- admin users (configured via `ADMIN_USER_IDS`) bypass rate limiting
- rate limits apply per user, not per server

## file size limits

default file size limits:

- videos: 500mb maximum
- images: 50mb maximum
- gif duration: 30 seconds maximum (configurable via `MAX_GIF_DURATION`)

admin users can bypass these limits.

## error messages

common error messages and what they mean:

- "rate limited. please wait before using another command." - you're using commands too quickly
- "file too large" - the file exceeds size limits
- "unsupported format" - the file type isn't supported
- "download failed" - the download couldn't complete (check url or cobalt status)
- "conversion failed" - ffmpeg couldn't process the file
