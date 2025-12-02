---
layout: post
title: "50 authorized users and postgres migration"
date: 2025-12-02
description: gronka hit 50 authorized discord users. also migrated to postgres. it was rough.
author: thedorekaczynski
tags:
  - milestone
  - announcement
  - database
  - postgres
---

# 50 authorized users and postgres migration

![50 users milestone](/assets/images/50-users-milestone.png)

gronka hit 50 authorized users in discord, woohoo

## the postgres migration

migrated from sqlite to postgres. it did not go smoothly.

gronka was down for many hours, didn't have a working database for four days. the bot worked just no logging

it's working now. postgres handles concurrent operations better than sqlite did, so that's good.

## what now

make sure it works and keep it up 😏

