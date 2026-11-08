# cerase-google-workspace-mcp

A Google Workspace MCP server for Drive, Docs, Sheets, Slides and Calendar. It is a fork of
[piotr-agier/google-drive-mcp](https://github.com/piotr-agier/google-drive-mcp) at release 2.13.0
(`@piotr-agier/google-drive-mcp`, commit `9509fb8`). It serves 130 tools, each described in the
[tool reference](docs/tools.md).

Every upstream tool keeps its name, its arguments and its behaviour. The server reads the same
credential files and variables as upstream (`~/.config/google-drive-mcp/tokens.json`,
`~/.config/google-drive-mcp/gcp-oauth.keys.json`, `GOOGLE_DRIVE_OAUTH_CREDENTIALS`), so an account
already connected to upstream works without being connected again.

## What the fork changes

Nothing yet beyond the packaging: the package is renamed `cerase-google-workspace-mcp`, marked
private, and carries a connector manifest, `cerase.json`.

## Build and run

Needs Node.js 22 or later.

```sh
npm ci
npm run build
npm prune --omit=dev
node dist/index.js
```

`node dist/index.js auth` runs upstream's browser authentication and writes `tokens.json`.

## Test

```sh
npm test
```

compiles the sources and the tests into `.tmp-test/`, builds the bundle, and runs Node's test
runner on every test. The tool handlers are called through an in-memory MCP client with the Google
API clients replaced by fakes (`test/helpers/mock-google-apis.ts`), so no Google account is
involved.

## Upstream documentation

| Guide | Covers |
|---|---|
| [Setup](docs/setup.md) | Google Cloud APIs, OAuth credentials and installation |
| [Client configuration](docs/clients.md) | Transports and client configuration |
| [Authentication](docs/authentication.md) | Local OAuth, multi-account, service accounts, external tokens and scopes |
| [Configuration](docs/configuration.md) | CLI flags, environment variables and defaults |
| [Deployment](docs/deployment.md) | Streamable HTTP, team mode and reverse-proxy security |
| [Tool reference](docs/tools.md) | Every tool, its arguments and what it answers |
| [Troubleshooting](docs/troubleshooting.md) | Authentication, API, identity and rate-limit problems |
| [Development](docs/development.md) | Repository structure, build commands and tests |

## Licence

MIT, see [LICENSE](LICENSE): upstream's copyright and licence, plus the copyright of the
modifications.
