# Security Policy

`cerase-google-workspace-mcp` is the Google Workspace connector of the Cerase
platform, a copy of
[piotr-agier/google-drive-mcp](https://github.com/piotr-agier/google-drive-mcp)
2.13.0. It runs with the OAuth token of a person's own Google account, so a
defect here can expose that account's Drive, Docs, Sheets, Slides, Calendar and
Forms, or change them in that person's name.

It is maintained by Guidance Studio S.r.l.

## Supported versions

The release unit is the `main` branch. Cerase builds it into its universal
connector runner image, published to `ghcr.io/cerase-ai/cerase-mcp-runner`. A
fix ships as a new commit on `main` and a new runner image; no earlier line is
patched.

## Reporting a vulnerability

Email **tech@guidance.studio** with `cerase-google-workspace-mcp` in the
subject. That mailbox reaches the maintainers.

Do not open an issue, a discussion or a pull request for a suspected
vulnerability. This repository is public, so any of those is a disclosure.

Include as much of this as you have:

- what the defect is, and which file or tool it is in
- the commit you tested
- steps to reproduce, or a proof of concept
- what an attacker gains, and what access they need to begin

Reports in English or Italian are equally welcome.

## Disclosure

Please hold details until a fixed runner image is published. We will tell you
when that happens, and we will credit you unless you prefer otherwise.

There is no paid bug bounty.

A defect this copy shares with the upstream project is reported to upstream's
maintainer by us, once a fix is ready here, unless you have reported it there
already.
