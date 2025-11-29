---
layout: post
title: "clean slate reset: all media deleted"
date: 2025-11-29
description: Announcement that all stored media (gifs, videos, images) have been deleted as part of a clean slate reset. Includes justification and what this means for users.
author: thedorekaczynski
tags:
  - announcement
  - maintenance
  - reset
  - storage
  - r2
---

# clean slate reset: all media deleted

we performed a complete clean slate reset of the gronka instance. all stored media has been deleted.

## what happened

we performed a complete clean slate reset of the gronka instance. this means:

- **all local media deleted** - every gif, video, and image stored locally has been removed
- **r2 bucket cleared** - all files in cloudflare r2 storage have been deleted
- **databases reset** - user data, operation logs, and processed url records have been wiped
- **fresh start** - we're starting from scratch with a clean slate

## why did we do this?

we performed this reset for several reasons:

1. **storage costs** - r2 storage was accumulating files and costs were increasing. starting fresh provides a clean baseline.

2. **database optimization** - the database had grown over time with various schema changes and migrations. a clean reset ensures we're working with the latest schema from the start.

3. **testing infrastructure** - we needed to test the new clean slate reset script. this provided an opportunity to validate the process.

4. **fresh metrics** - starting from zero gives us clean metrics and usage statistics going forward.

## what this means for you

if you had gifs or media stored through gronka, they're gone. we don't have backups.

**going forward:**

- new conversions will work normally - the bot is still fully functional
- all features remain available - nothing has changed in terms of functionality
- your discord commands still work - `/convert`, `/download`, `/optimize` all work as before
- fresh start for everyone - we're all starting from zero together
- r2 expiration is now live - any media uploaded to r2 storage will be automatically deleted after 72 hours. download your files if you want to keep them longer than that

## technical details

for the technically curious, here's what actually happened:

1. **local data deletion** - deleted `data-prod/`, `data-test/`, `temp/`, and `logs/` directories
2. **r2 bucket clearing** - listed all objects in the r2 bucket and deleted them in batches
3. **database reset** - removed all database files, which will be recreated on next use
4. **process cleanup** - stopped any running bot/server processes before deletion

we used a new `reset-clean-slate.js` script that automates this entire process. it's available in the repository if you want to perform your own clean slate reset (though we don't recommend it unless you really know what you're doing).

## lessons learned

we recognize that advance notice would have been preferable. going forward, we'll consider providing advance notice for similar operations and continue to document the reset process.

## moving forward

gronka is still fully functional and ready to convert your videos to gifs. all previous conversions have been removed from the system.

if you need something converted, use the bot as normal. it will work fine. you just won't find any of your old conversions in the system anymore. remember, any new files you upload to r2 will only remain for 72 hours before being automatically deleted. if you want to keep your conversions longer, make sure to download them within that window.

## questions?

if you have questions or concerns, feel free to open an issue on github. we won't be able to restore anything, but we're happy to explain why we did what we did.

---

**tl;dr:** we deleted all stored media. the bot still works. r2 expiration is now live (72 hours).
