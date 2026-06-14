# Security policy

## Supported versions

Security fixes are applied on the `main` branch. There are no long-term release branches yet.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security-sensitive reports.

Use [GitHub private vulnerability reporting](https://github.com/nejcm/market-bot/security/advisories/new) on this repository's **Security** tab. Include:

- A description of the issue and likely impact
- Steps to reproduce, if applicable
- Any suggested fix or mitigation

Enable **Private vulnerability reporting** under repository **Settings → Security → Code security and analysis** if the advisory form is not available yet.

## Scope notes

- `market-bot` is a **local research CLI**. It fetches public market data and writes artifacts to disk. It does not execute trades, hold credentials for broker accounts, or expose a public network service by default.
- The Research Console App binds to `127.0.0.1` only. Do not expose it to untrusted networks without adding your own authentication and TLS.
- API keys and provider tokens belong in environment variables (`.env`), never in code, tests, fixtures, or committed artifacts. See [docs/configuration.md](./docs/configuration.md).
