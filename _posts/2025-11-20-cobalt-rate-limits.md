---
layout: post
title: cobalt rate limits and implementation
date: 2025-11-20
description: Understanding the limitations of gronka's cobalt integration, including IP-based rate limiting, platform-specific restrictions, and service disruption scenarios.
author: thedorekaczynski
tags:
  - technical
  - limitations
  - rate-limits
  - cobalt
---

## rate limit handling

when rate limit errors occur, the system extracts the `Retry-After` header from the response if available, otherwise defaulting to a 5-minute wait period. the download command will fail with a rate limit error message, and users are instructed to try again later.

## limitations

despite the improved rate limit handling, several fundamental limitations remain that can disrupt service for users.

### ip-based rate limiting

when multiple users download from the same social media platform, all requests originate from the same server ip address. social media platforms implement ip-based rate limiting that affects all requests from that ip, regardless of which user initiated the download.

if the server ip gets rate limited by a platform like twitter/x, all users attempting downloads from that platform will fail simultaneously. users will receive an error message and must wait before trying again.

there is no technical recourse once the server ip is blocked beyond waiting for the limit to expire.

this affects all users equally. one user downloading multiple items from twitter can cause the server ip to hit rate limits, making the service unavailable for all other users trying to download from twitter. the system cannot distinguish between different users at the ip level, so the rate limit is shared across all requests.

### platform-specific limits

different platforms have different rate limit policies and enforcement. the system attempts to detect rate limiting through response codes, timing analysis, and error message parsing, but these are heuristics that may not always accurately identify the cause of failures. platforms may change their rate limit implementation without notice, breaking detection logic.

when a platform provides a `Retry-After` header, the system uses it directly. however, not all platforms include this header, and some may provide it in different formats.

the system defaults to a 5-minute wait when the header is missing or invalid, which may not match the actual rate limit window.

some platforms may implement stricter limits during peak usage times or for specific content types. the system cannot adapt to these dynamic limits automatically, and the exponential backoff may not be sufficient if rate limits persist longer than expected.

### retry exhaustion

downloads that fail due to rate limiting will return an error to the user immediately. users must manually retry the download after waiting for the rate limit to expire.

### error ambiguity

the cobalt api returns identical error codes for different failure scenarios. an `error.api.fetch.empty` response can indicate rate limiting, deleted content, private accounts, or network issues.

the system uses timing analysis and error text parsing to distinguish these cases, but this is imperfect. false positives may occur where deleted content is misidentified as rate limiting, or vice versa.

when content genuinely does not exist, the system correctly stops retrying. however, if rate limiting is misidentified as a permanent failure, users may not get their downloads even after rate limits clear. the improved rate limit detection helps reduce this issue, but ambiguity remains for edge cases.

### service disruption scope

if a server ip gets rate limited by a major platform like twitter or tiktok during peak usage, the impact is immediate and affects all users. all download attempts from that platform will fail until the rate limit expires.

this creates a single point of failure where one platform's rate limits can disable download functionality for all users, regardless of which specific content they are trying to access. there is no automatic retry mechanism - users must wait and manually retry their downloads.
