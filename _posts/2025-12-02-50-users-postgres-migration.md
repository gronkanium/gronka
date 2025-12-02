---
layout: post
title: "50 authorized users and postgres migration"
date: 2025-12-02
description: celebrating 50 authorized users in discord and postgres migration
author: thedorekaczynski
tags:
  - milestone
  - announcement
  - database
  - postgres
---

# we hit 50 users in discord!

![50 users milestone](/assets/images/50-users-milestone.png)

gronka hit 50 authorized users in discord, woohoo

this number is derived from the amount of users that have the bot added to their discord account, not actual users sadly

## the postgres migration

we began migrating to postgres after 3 sqlite databases corrupted most likely due to file locking or something like that

we now have proper async and concurrent writes, a lacking feature in sqlite, this allows for many users to make alot of requests and operations without gronka slowing behind!

## what's next?

make sure it works and keep it up 😏

no really we just want uptime at this moment, everything *LOOKS* good.

