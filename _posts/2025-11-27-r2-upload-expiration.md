---
layout: post
title: r2 upload expiration policy
date: 2025-11-27
description: Future policy change for R2 uploads - files will be automatically deleted after 72 hours maximum retention period. Currently uploads remain persistent.
author: thedorekaczynski
tags:
  - announcement
  - r2
  - storage
  - policy
---

# r2 upload expiration policy

this is a notice about a future change to how r2 uploads are handled, this is not currently active and uploads remain persistent for the foreseeable future

## current state

uploads to cloudflare r2 are currently persistent, files uploaded through gronka remain available indefinitely, there is no automatic deletion or expiration

## future policy

going forward, r2 uploads will have a maximum retention period of 72 hours, after which files will be automatically deleted from storage

this change will be implemented at a later date, it is not active now and there is no timeline for when it will be implemented

## why

storage costs accumulate over time, and most uploads are accessed shortly after creation, implementing a 72-hour retention period balances availability with cost management

## what this means

when this policy is implemented, any file uploaded to r2 will be deleted 72 hours after upload, users should download or save files they want to keep before the retention period expires

for now, nothing changes, uploads remain persistent as they always have been

