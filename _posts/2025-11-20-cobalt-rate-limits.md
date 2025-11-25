---
layout: post
title: cobalt rate limits and implementation
date: 2025-11-20
description: Understanding the limitations of gronka's cobalt integration, including IP-based rate limiting, platform-specific restrictions, and service disruption scenarios.
author: p2xai
tags:
  - technical
  - limitations
  - rate-limits
  - cobalt
---

## rate limit handling

the deferred download queue implements rate limit detection and waiting to avoid repeatedly hitting 429 errors. on rate limit errors, the system extracts the `Retry-After` header from the response if available, otherwise defaulting to a 5-minute wait period.

queue items are marked with a `rate_limited` status and stored with timing information indicating when the rate limit occurred and how long to wait before retrying.

the queue processor checks expiration times before attempting to process items. items that are still within their rate limit window are skipped entirely, preventing unnecessary api calls. when the rate limit expires, items are automatically converted back to `pending` status and will be processed in the next queue cycle.

for repeated rate limit errors on the same item, exponential backoff is applied. the first rate limit uses the original retry time, the second doubles it, and the third quadruples it, capped at 4x the original duration. this prevents persistent rate limit violations from consuming resources while still allowing eventual retry.

the system respects rate limit timing rather than blindly retrying every 2 minutes. this reduces api load and improves the likelihood of successful downloads once rate limits clear.

## limitations

despite the improved rate limit handling, several fundamental limitations remain that can disrupt service for users.

### ip-based rate limiting

when multiple users download from the same social media platform, all requests originate from the same server ip address. social media platforms implement ip-based rate limiting that affects all requests from that ip, regardless of which user initiated the download.

if the server ip gets rate limited by a platform like twitter/x, all users attempting downloads from that platform will fail simultaneously. the deferred download queue will wait for the rate limit to expire based on the `Retry-After` header or default timing, but all queued items for that platform will remain blocked until the rate limit window resets.

there is no technical recourse once the server ip is blocked beyond waiting for the limit to expire.

this affects all users equally. one user downloading multiple items from twitter can cause the server ip to hit rate limits, making the service unavailable for all other users trying to download from twitter. the system cannot distinguish between different users at the ip level, so the rate limit is shared across all requests.

### platform-specific limits

different platforms have different rate limit policies and enforcement. the system attempts to detect rate limiting through response codes, timing analysis, and error message parsing, but these are heuristics that may not always accurately identify the cause of failures. platforms may change their rate limit implementation without notice, breaking detection logic.

when a platform provides a `Retry-After` header, the system uses it directly. however, not all platforms include this header, and some may provide it in different formats.

the system defaults to a 5-minute wait when the header is missing or invalid, which may not match the actual rate limit window.

some platforms may implement stricter limits during peak usage times or for specific content types. the system cannot adapt to these dynamic limits automatically, and the exponential backoff may not be sufficient if rate limits persist longer than expected.

### retry exhaustion

the deferred download queue retries failed downloads up to 10 times. rate-limited items are not counted toward this limit, as they are handled separately with their own timing. however, if rate limiting persists and the exponential backoff extends beyond a reasonable timeframe, or if non-rate-limit errors accumulate, downloads will permanently fail and users will be notified of the failure.

there is no mechanism to indefinitely retry downloads, as this would consume resources on requests that may never succeed. the 10-retry limit applies to general failures, while rate-limited items can wait longer but are still subject to practical limits.

### error ambiguity

the cobalt api returns identical error codes for different failure scenarios. an `error.api.fetch.empty` response can indicate rate limiting, deleted content, private accounts, or network issues.

the system uses timing analysis and error text parsing to distinguish these cases, but this is imperfect. false positives may occur where deleted content is misidentified as rate limiting, or vice versa.

when content genuinely does not exist, the system correctly stops retrying. however, if rate limiting is misidentified as a permanent failure, users may not get their downloads even after rate limits clear. the improved rate limit detection helps reduce this issue, but ambiguity remains for edge cases.

### service disruption scope

if a server ip gets rate limited by a major platform like twitter or tiktok during peak usage, the impact is immediate and affects all users. the deferred download queue will wait for the rate limit to expire, but all queued items for that platform will remain blocked until the platform allows requests from the ip again.

this creates a single point of failure where one platform's rate limits can disable download functionality for all users, regardless of which specific content they are trying to access. the improved waiting mechanism prevents unnecessary retries, but cannot eliminate the fundamental limitation of shared ip-based rate limits.
