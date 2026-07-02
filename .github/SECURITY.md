# security policy

this security policy outlines how we handle security for gronka and how to report vulnerabilities. if you find a security issue, report it responsibly.

## reporting vulnerabilities

if you find a security vulnerability, report it to: **gronkasupport@proton.me**

include this stuff in your report:

- what the vulnerability is
- how bad it could be
- steps to reproduce it
- which parts of the service are affected
- if you have ideas on how to fix it (optional)

### what we're interested in

security issues that affect:

- authentication or authorization problems
- data leaks or exposure
- remote code execution
- server-side request forgery (SSRF)
- directory traversal or unauthorized file access
- denial of service vulnerabilities
- input validation problems that cause security issues

### out of scope

these aren't considered security vulnerabilities:

- missing security headers (unless they actually cause a vulnerability)
- normal usage causing resource exhaustion
- issues that need physical server access
- social engineering scenarios
- self-xss or issues that need compromised accounts
- rate limiting or abuse prevention stuff

## security measures

### data protection

- files are stored on cloudflare r2 or local filesystem with proper access controls
- files are identified by MD5 hash for deduplication and integrity checking
- storage access is restricted to necessary operations only
- user data isn't directly linked to stored files

### authentication

- authentication is handled through discord's system
- bot tokens and api credentials are stored as environment variables, never in code or logs
- sensitive credentials are managed through environment variables

### network security

- public endpoints use HTTPS where applicable
- internal APIs aren't exposed to the public internet when using r2 storage
- command usage is rate-limited to prevent abuse

### input validation

we validate and sanitize inputs:

- only allowed file types are processed
- file size limits are enforced
- URLs are validated before downloading
- filenames are sanitized to prevent directory traversal attacks

### error handling

- error logs don't contain sensitive information like tokens or credentials
- public error messages don't reveal system internals
- exceptions are handled to prevent information leakage

## security best practices

### for users

- keep your discord account secure with a good password and 2FA
- don't share sensitive information through the bot
- report suspicious behavior
- use the service responsibly

### for contributors

if you're working on the code:

- validate all inputs
- never commit secrets, tokens, or credentials
- use environment variables for sensitive config
- review dependencies for security updates

## third-party services

the bot uses these services:

- **discord** - bot platform and API provider
- **cloudflare r2** - file storage
- **node.js** - runtime environment

we rely on these services to maintain their security. we can't guarantee their security beyond what they provide.

## security updates

security patches are applied as they become available. critical issues are fixed immediately. vulnerabilities are disclosed after they're patched.

if you're running your own instance, keep dependencies updated.

## limitations

we implement security measures but can't guarantee absolute security. no system is completely secure. new vulnerabilities might be discovered.

we may temporarily suspend service to address security issues if needed.

## contact

for security-related questions or concerns:

- **email**: gronkasupport@proton.me
- **github**: [https://github.com/gronkanium/gronka](https://github.com/gronkanium/gronka)

use email for security vulnerability reports. don't disclose vulnerabilities publicly until they're resolved.

---

_this security policy may be updated from time to time. check back occasionally if you care about that stuff._
