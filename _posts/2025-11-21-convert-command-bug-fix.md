---
layout: post
title: convert command bug fix
date: 2025-11-21
description: Fixed a critical bug in the /convert command that made both file and url parameters required, preventing users from using the command for 19 hours.
author: p2xai
tags:
  - bug-fix
  - changelog
  - convert
---

## the bug

an incorrect configuration of the `/convert` command required both `file` and `url` parameters simultaneously. this prevented any user from using the command, as discord's command validation requires all marked `required: true` fields to be provided.

the command handler already supported either a file attachment or a url, but the command definition in `register-commands.js` enforced both fields as required, making the command unusable.

## when it was introduced

the bug was introduced in commit `a486d4e` on november 20, 2025 at 13:05:17. the commit message stated "enforce required fields in register-commands.js", which inadvertently made both parameters required when they should have been optional.

the bug existed for approximately 19 hours (18 hours and 57 minutes) before being fixed today.

## the fix

both `file` and `url` parameters were changed from `required: true` to `required: false`. the command handler already validates that at least one parameter is provided, so the command now works correctly with either a file attachment or a url.

## impact

during the 19-hour window, users attempting to use `/convert` would have been unable to submit the command due to discord's validation requiring both fields. the context menu command "convert to gif" was unaffected and continued to work normally.

we are sorry for any users affected and are committed to providing a working service 100% of the time.
