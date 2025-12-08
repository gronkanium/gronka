---
layout: post
title: "yt-dlp youtube integration"
date: 2025-12-08
description: youtube downloads now work with yt-dlp integration
author: thedorekaczynski
tags:
  - feature
  - announcement
  - youtube
  - yt-dlp
---

# youtube downloads are back!

we've integrated yt-dlp for youtube downloads, replacing the previous blacklist that blocked all youtube urls.

## what changed?

youtube urls now automatically use yt-dlp instead of being rejected. the bot detects youtube links and routes them to yt-dlp for reliable downloads.

regular users get 1080p max quality, while admins can download the best available quality.

## why yt-dlp?

cobalt.tools hasn't supported it for a while and recommends yt-dlp

yt-dlp is bundled in the docker image, so no extra setup needed if you're using docker. for local development, just install yt-dlp with `pip install yt-dlp`.

## what's next?

keep downloading and converting videos to gifs, now with youtube support!
