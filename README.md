# call-mcp

A CLI for calling MCP servers: define servers in a small config file (MCP
Streamable HTTP or stdio), and/or use the connectors you've set up in claude.ai
(those reuse the Claude Code OAuth token — no separate login).

Every command prints JSON to stdout, on success and on error alike, so output
is always safe to pipe into `jq` or parse in a script.

## Install

```
npm install -g call-mcp
```

Requires Node 20+. Works on macOS, Linux, and Windows. Servers from your own
config need no other setup; claude.ai connectors need a Claude Code login (or
`CLAUDE_CODE_OAUTH_TOKEN`).

## Usage

```
call-mcp list                                List your servers and claude.ai connectors
call-mcp tools <server>                      List the tools a server exposes
call-mcp call <server> <tool> [--args JSON]  Call a tool
call-mcp help                                Full help with examples
```

`<server>` is a server name from your config file, a claude.ai connector's
display name, or a connector id (`mcpsrv_...`) — a unique case-insensitive
prefix also works, e.g. `google`.

`--args <json>` passes a JSON object of arguments to `call`.

`--full` includes full detail in the output. By default call-mcp prints slim
objects; `--full` adds tool input/output schemas, raw server fields, and the
complete tool-call result envelope. Keep it slim and search first — fetch a
full schema only for the tool you actually need.

## Configuring servers

Define your servers in `~/.config/call-mcp/servers.json` (or point
`CALL_MCP_SERVERS_FILE` at a file), using the same `mcpServers` shape as Claude
Code's MCP config — blocks copy-paste between the two:

```json
{
  "mcpServers": {
    "homelab": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
    },
    "everything": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"]
    }
  }
}
```

- `"http"` is MCP Streamable HTTP; `"stdio"` spawns the command per invocation
  and shuts it down afterwards. The legacy SSE transport is not supported.
- `${VAR}` placeholders expand from the environment at call time, so secrets
  stay out of the file (and out of `list --full`).
- Servers that require OAuth work out of the box: on first use call-mcp opens
  your browser to authorize and caches tokens under `~/.config/call-mcp/auth/`.
- Configured servers need no claude.ai or Claude Code login.

Servers show up in `call-mcp list` with `"source": "config"`, claude.ai
connectors with `"source": "claude.ai"`; `tools` and `call` take either by
name. See the `CONFIGURING SERVERS` section of `call-mcp help` for details.

### Examples

```sh
call-mcp list
call-mcp tools 'Google Drive'
call-mcp call 'Google Drive' search_files --args '{"query":"name contains '\''q3'\''"}'
call-mcp call Aggregator gmail__threads_list --args '{"maxResults":5,"q":"is:unread"}'

# Search tools by keyword (name + description) without loading any schemas
call-mcp tools Aggregator | jq -r '.tools[]
  | select((.name + " " + .description) | test("calendar";"i")) | .name'

# Then pull the full schema for just the one you want
call-mcp tools Aggregator --full | jq '.tools[]
  | select(.name == "gmail__threads_list") | .inputSchema'
```

Run `call-mcp help` for the full set, including cross-server tool search and
error-handling recipes.

## How it works

- **Auth**: reuses the Claude Code OAuth token, resolved the same way Claude
  Code stores it:
  1. `CLAUDE_CODE_OAUTH_TOKEN` env var, if set (any platform).
  2. macOS: the login Keychain (`Claude Code-credentials`), falling back to the
     credentials file.
  3. Linux / Windows: the plaintext credentials file at
     `<config-dir>/.credentials.json`.

  The config dir is `CLAUDE_CONFIG_DIR` if set, else `~/.claude`. The token
  already carries the `user:mcp_servers` scope. call-mcp never writes credentials
  back; if the token has expired it tells you to run `claude` once to refresh
  it.
- **Discovery**: `GET https://api.anthropic.com/v1/mcp_servers` lists your
  configured servers.
- **Tool calls**: each server is reached through the claude.ai MCP proxy at
  `https://mcp-proxy.anthropic.com/v1/mcp/{server_id}`, speaking MCP over
  Streamable HTTP. The proxy uses a client-supplied `X-Mcp-Client-Session-Id`
  rather than a server-issued session id, so call-mcp ships a small custom
  transport (`src/transport.ts`) on top of the official MCP SDK's `Client`.

Currently this targets claude.ai-hosted connectors specifically — not
local/stdio or arbitrary remote MCP servers.

A connector can also need its own authorization (e.g. a Google login). When
that happens call-mcp returns `{ "error": ..., "authUrl": ... }` — open that URL to
(re-)connect the server in claude.ai settings.

### Source layout

| File               | Responsibility                                                   |
| ------------------ | ---------------------------------------------------------------- |
| `src/auth.ts`      | Resolve + validate the Claude Code token (env / Keychain / file) |
| `src/discovery.ts` | List servers, resolve a user ref to a server                     |
| `src/transport.ts` | MCP Streamable HTTP transport for the claude.ai proxy            |
| `src/client.ts`    | Connect / list tools / call tool via the MCP SDK `Client`        |
| `src/cli.ts`       | Argument parsing and command dispatch                            |

## Contributing

Pull requests are welcomed on GitHub! To get started:

1. Install Git and Node.js
2. Clone the repository
3. Install dependencies with `npm install`
4. Run `npm run test` to run tests
5. Build with `npm run build`

To try your build locally, `npm link` it (symlinks `call-mcp` to your build and
picks up rebuilds), or run `node dist/cli.js` directly.

## Releases

Versions follow the [semantic versioning spec](https://semver.org/).

To release:

1. Use `npm version <major | minor | patch>` to bump the version
2. Run `git push --follow-tags` to push with tags
3. Wait for GitHub Actions to publish to the NPM registry.
