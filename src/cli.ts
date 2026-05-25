#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {AuthError, getToken, type Token} from './auth.js';
import {callTool, connect, listTools} from './client.js';
import {
	DiscoveryError, listServers, resolveServer, type McpServer,
} from './discovery.js';
import {
	connectConfiguredServer, loadConfiguredServers, ServersConfigError, type ConfiguredServer,
} from './config-servers.js';
import {ConnectorAuthError} from './transport.js';

const HELP = `call-mcp — a CLI for calling MCP servers

call-mcp talks to MCP servers you define in a small config file — over MCP
Streamable HTTP or stdio — and to the connectors you have set up in claude.ai,
reusing the Claude Code OAuth token so there is no separate login.
See CONFIGURING SERVERS for the config file, and AUTH for the claude.ai side.

USAGE
  call-mcp <command> [arguments] [options]

COMMANDS
  list                       List your configured servers and claude.ai connectors.
  tools <server>             List the tools a server exposes.
  call  <server> <tool>      Call a tool on a server.
  help                       Show this help. (also: -h, --help)

ARGUMENTS
  <server>   A server name from your config file, a claude.ai connector's
             display name, or a connector id (mcpsrv_...). Names are matched
             case-insensitively; a unique prefix also works, e.g. 'homelab',
             'Google Drive', or 'google'.
  <tool>     The exact tool name as shown by 'call-mcp tools <server>'.

OPTIONS
  --args <json>   JSON object of arguments for 'call' (default: {}).
                  Must be a JSON object, e.g. --args '{"query":"report"}'.
                  Pass --args - to read the JSON from stdin (no size limit;
                  good for large payloads like file uploads). See STDIN below.
  --full          Include full detail in the output. By default call-mcp prints
                  slim objects; --full adds tool input/output schemas,
                  annotations, raw server fields, and the complete tool-call
                  result envelope.
  -h, --help      Show this help.

OUTPUT
  Every command prints JSON to stdout — on success and on error — so output
  is always safe to pipe into jq or parse in a script. Errors are a JSON
  object { "error": ... } and the process exits non-zero. Pretty-print with
  'call-mcp list | jq'.

  list           default: [{ id, display_name, url, source }]
                          (source is "config" for servers from your config file,
                          "claude.ai" for connectors)
                 --full:  config servers include their (unexpanded) config;
                          claude.ai entries are the raw /v1/mcp_servers objects
  tools <s>      default: { server, tools: [{ name, description }] }
                 --full:  tools include inputSchema, outputSchema, annotations
  call <s> <t>   default: the tool's structuredContent, or its text content
                 --full:  the complete MCP CallToolResult { content,
                          structuredContent, isError }

CONFIGURING SERVERS
  Define your servers in a JSON config file. call-mcp reads the first of these
  that exists:
    1. $CALL_MCP_SERVERS_FILE (if set)
    2. $XDG_CONFIG_HOME/call-mcp/servers.json (default ~/.config/call-mcp/servers.json)
  The file uses the same "mcpServers" shape as Claude Code's MCP config, so
  blocks can be copy-pasted between the two:
    {
      "mcpServers": {
        "homelab":    { "type": "http",  "url": "https://mcp.example.com/mcp",
                        "headers": { "Authorization": "Bearer \${MY_TOKEN}" } },
        "everything": { "type": "stdio", "command": "npx",
                        "args": ["-y", "@modelcontextprotocol/server-everything"] }
      }
    }
  Notes:
  - "http" is MCP Streamable HTTP. The legacy SSE transport is not supported.
  - stdio servers are spawned per invocation and shut down afterwards. Fine for
    request/response servers; not suitable for stateful ones (e.g. browser
    automation sessions).
  - \${VAR} placeholders in url/headers/command/args/env expand from the
    environment when the server is contacted, so secrets stay out of the file
    (and out of 'list --full', which shows the unexpanded config).
  - Servers that need their own OAuth flow aren't supported yet — use a static
    Authorization header, or set them up as claude.ai connectors instead.
  - Configured servers work without any Claude Code login when referenced by
    their exact name; 'list' just skips claude.ai connectors (with a note on
    stderr) if you aren't logged in.

QUOTING
  --args takes a JSON string, and JSON uses double quotes — so wrap the whole
  value in single quotes: --args '{"query":"report"}'. The jq examples below
  use single quotes for the same reason. Escaping rules differ between shells
  (bash/zsh vs fish vs nushell); if quoting misbehaves, run 'echo $SHELL' to
  see which shell you are in and check its quoting rules.

STDIN (--args -)
  Pass --args - to read the JSON object from stdin instead of the command line.
  This avoids all shell quoting/escaping AND the OS argument-size limit (ARG_MAX,
  ~1MB on macOS) that otherwise breaks large payloads — e.g. base64-encoded file
  uploads. Use it whenever args are large or awkward to quote:
    cat args.json | call-mcp call <server> <tool> --args -
    jq -n --arg b64 "$(base64 < big.pdf)" '{file_content_base64:$b64,filename:"big.pdf"}' \\
      | call-mcp call <server> upload_tool --args -

EXAMPLES
  Core flows
    call-mcp list
    call-mcp tools 'Google Drive'
    call-mcp call 'Google Drive' search_files --args '{"query":"name contains \\'q3\\'"}'
    call-mcp call Aggregator gmail__get_profile

  Progressive disclosure — don't load every schema, search first
    A server can expose hundreds of tools. Even the slim 'tools' output (name
    + description) can be large, so don't read it whole — filter it with jq:
    narrow to a keyword, or take just the names. Fetch a full schema only for
    the one tool you actually need. This keeps context small — the same idea
    as https://www.anthropic.com/engineering/code-execution-with-mcp

    Just the tool names (the leanest possible view):
      call-mcp tools Aggregator | jq -r '.tools[].name'

    Find tools by keyword — matches name AND description, case-insensitive
    (the ;"i" is jq's regex flag). Returns name + description so you can tell
    which match is the one you want:
      call-mcp tools Aggregator | jq -r \\
        '.tools[] | select((.name + " " + .description)|test("calendar";"i"))
                  | "\\(.name)\\t\\(.description)"'

    Search every server at once (which connector has a "send email" tool?):
      call-mcp list | jq -r '.[].id' | while read -r id; do
        call-mcp tools "$id" | jq -r --arg s "$id" \\
          '.tools[] | select((.name + " " + .description)|test("email";"i"))
                    | "\\($s)\\t\\(.name)"'
      done

    Then — and only then — pull the full schema for the chosen tool:
      call-mcp tools Aggregator --full \\
        | jq '.tools[] | select(.name=="gmail__threads_list") | .inputSchema'

  Filter results before they reach you (don't pipe a 10k-row payload around)
    call-mcp call Aggregator gmail__threads_list --args '{"maxResults":100}' \\
      | jq '[.threads[] | {id, snippet}]'

  Nested / complex arguments
    call-mcp call Aggregator gmail__message_send \\
      --args '{"to":["a@example.com"],"subject":"Hi","body":"text"}'

  Large or binary results — keep them out of your context
    Each 'call' is one isolated invocation; call-mcp is just transport. To chain
    tools, filter, or orchestrate, pipe stdout through jq in the shell — not
    through an LLM context. For binary data (images, files), don't print
    base64 to the terminal: with '--full', pull the data out with jq and
    decode it straight to a file, so the bytes never hit context.
      call-mcp call Aggregator some__tool --full \\
        | jq -r '.content[] | select(.type=="image") | .data' \\
        | base64 -d > /tmp/out.png

  Referring to a server by id instead of name
    call-mcp tools mcpsrv_01DjiBkJL2oUsCpddEd4h56J

  Scripting (errors land in stdout too, so this stays robust)
    out=$(call-mcp call 'Google Drive' search_files --args '{"query":"x"}')
    echo "$out" | jq -e '.error' >/dev/null \\
      && echo "failed: $(echo "$out" | jq -r '.error')" \\
      || echo "$out" | jq '.files'

AUTH
  call-mcp resolves the Claude Code token in this order:
    1. CLAUDE_CODE_OAUTH_TOKEN environment variable, if set.
    2. macOS: the login Keychain, then ~/.claude/.credentials.json.
    3. Linux / Windows: ~/.claude/.credentials.json
       (or $CLAUDE_CONFIG_DIR/.credentials.json).
  If the token is missing or expired, run 'claude' once to refresh it. call-mcp
  never writes credentials back.

  A connector can also need its own authorization (e.g. a Google login). When
  that happens call-mcp returns { "error": ..., "authUrl": ... } — open that URL
  to (re-)connect the server in claude.ai settings.
`;

/** Raised internally when the stdout reader has gone away (broken pipe). */
class BrokenPipe extends Error {}

/**
 * Writes a string to stdout and resolves only once it has been fully flushed.
 * `process.stdout.write` can return `false` for large payloads when stdout is
 * a pipe; exiting before the buffer drains truncates the output (e.g. jq then
 * sees a half-written JSON document). Awaiting the drain prevents that.
 *
 * If the reader has closed the pipe (EPIPE — e.g. `call-mcp ... | head`), this is
 * normal Unix behaviour, not an error: it surfaces as BrokenPipe so the caller
 * can exit quietly.
 */
async function writeOut(text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		process.stdout.write(text, (err) => {
			if (!err) {
				resolve();
				return;
			}

			if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
				reject(new BrokenPipe());
				return;
			}

			reject(err);
		});
	});
}

/** Reads all of stdin as a UTF-8 string. Used by `--args -` for large payloads. */
async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
	}

	return Buffer.concat(chunks).toString('utf8');
}

/** Emits a success payload as compact JSON on stdout. */
async function emit(data: unknown): Promise<number> {
	await writeOut(`${JSON.stringify(data)}\n`);
	return 0;
}

/**
 * Emits an error as a JSON object on stdout (not stderr) so that piping into
 * jq or a script can never silently swallow it. Returns the process exit code.
 */
async function fail(error: string, extras: Record<string, unknown> = {}): Promise<number> {
	await writeOut(`${JSON.stringify({error, ...extras})}\n`);
	return 1;
}

async function main(argv: string[]): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				args: {type: 'string'},
				full: {type: 'boolean', default: false},
				help: {type: 'boolean', short: 'h', default: false},
			},
		});
	} catch (err) {
		return fail(`Invalid arguments: ${(err as Error).message}`, {hint: 'Run `call-mcp --help`.'});
	}

	const {values, positionals} = parsed;
	const command = positionals[0];

	if (values.help || command === 'help') {
		await writeOut(HELP);
		return 0;
	}

	if (!command) {
		await writeOut(HELP);
		return fail('No command given.', {hint: 'Run `call-mcp --help` for usage.'});
	}

	switch (command) {
		case 'list':
			return cmdList(values.full);
		case 'tools':
			return cmdTools(positionals[1], values.full);
		case 'call':
			return cmdCall(positionals[1], positionals[2], values.args, values.full);
		default:
			return fail(`Unknown command: ${command}`, {
				hint: 'Valid commands: list, tools, call. Run `call-mcp --help`.',
			});
	}
}

/**
 * Resolves a server reference across configured servers and claude.ai
 * connectors. An exact match on a configured server's name short-circuits
 * before any claude.ai call, so configured servers work without a Claude Code
 * login; if claude.ai discovery fails, resolution falls back to configured
 * servers only.
 */
async function resolveRef(ref: string): Promise<{configured: ConfiguredServer} | {remote: McpServer; token: Token}> {
	const configured = await loadConfiguredServers();
	const exact = configured.filter((s) => s.id === ref || s.display_name.toLowerCase() === ref.toLowerCase());
	if (exact.length === 1) {
		return {configured: exact[0]!};
	}

	let token: Token;
	let connectors: McpServer[];
	try {
		token = await getToken();
		connectors = await listServers(token);
	} catch (err) {
		if ((err instanceof AuthError || err instanceof DiscoveryError) && configured.length > 0) {
			return {configured: resolveServer(configured, ref)};
		}

		throw err;
	}

	const resolved = resolveServer([...configured, ...connectors] as (McpServer | ConfiguredServer)[], ref);
	if ('source' in resolved && resolved.source === 'config') {
		return {configured: resolved};
	}

	return {remote: resolved as McpServer, token};
}

async function cmdList(full: boolean): Promise<number> {
	const configured = await loadConfiguredServers();

	let connectors: McpServer[] = [];
	try {
		const token = await getToken();
		connectors = await listServers(token);
	} catch (err) {
		// claude.ai connectors are optional: if you have your own servers configured
		// and aren't logged in (or discovery is unreachable), still list yours.
		if (!(err instanceof AuthError || err instanceof DiscoveryError) || configured.length === 0) {
			throw err;
		}

		process.stderr.write(`note: skipping claude.ai connectors: ${(err as Error).message.split('\n')[0]}\n`);
	}

	if (full) {
		return emit([
			...configured.map((s) => ({
				id: s.id, display_name: s.display_name, url: s.url, source: s.source, config_path: s.configPath, config: s.config,
			})),
			...connectors.map((s) => ({...s, source: 'claude.ai'})),
		]);
	}

	return emit([
		...configured.map((s) => ({
			id: s.id, display_name: s.display_name, url: s.url, source: s.source,
		})),
		...connectors.map((s) => ({
			id: s.id, display_name: s.display_name, url: s.url, source: 'claude.ai',
		})),
	]);
}

async function cmdTools(ref: string | undefined, full: boolean): Promise<number> {
	if (!ref) {
		return fail('Missing <server> argument.', {
			hint: 'Usage: call-mcp tools <server>. Run `call-mcp list` to see servers.',
		});
	}

	const target = await resolveRef(ref);
	const server = 'configured' in target ? target.configured : target.remote;

	const client = 'configured' in target
		? await connectConfiguredServer(target.configured)
		: await connect(target.remote.id, target.token.accessToken);
	try {
		const tools = await listTools(client);
		if (full) {
			return await emit({server: {id: server.id, display_name: server.display_name}, tools});
		}

		return await emit({
			server: {id: server.id, display_name: server.display_name},
			tools: tools.map((t) => ({name: t.name, description: t.description ?? null})),
		});
	} finally {
		await client.close();
	}
}

async function cmdCall(
	ref: string | undefined,
	toolName: string | undefined,
	argsJson: string | undefined,
	full: boolean,
): Promise<number> {
	if (!ref || !toolName) {
		return fail('Missing argument(s).', {
			hint: 'Usage: call-mcp call <server> <tool> [--args JSON]. Run `call-mcp tools <server>` to see tool names.',
		});
	}

	let args: Record<string, unknown> = {};
	if (argsJson !== undefined) {
		// `--args -` reads the JSON from stdin. This sidesteps the OS argv size
		// limit (ARG_MAX, ~1MB on macOS) that otherwise breaks large payloads
		// like base64-encoded file uploads. Compose with: `cat big.json | call-mcp call … --args -`.
		let rawJson = argsJson;
		if (argsJson === '-') {
			try {
				rawJson = await readStdin();
			} catch (err) {
				return fail(`Could not read --args from stdin: ${(err as Error).message}`, {
					hint: 'Pipe JSON in, e.g. `cat args.json | call-mcp call <server> <tool> --args -`.',
				});
			}

			if (rawJson.trim() === '') {
				return fail('--args is - but stdin was empty.', {
					hint: 'Pipe a JSON object in, e.g. `echo \'{"q":"x"}\' | call-mcp … --args -`.',
				});
			}
		}

		let parsedArgs: unknown;
		try {
			parsedArgs = JSON.parse(rawJson);
		} catch (err) {
			return fail(`--args is not valid JSON: ${(err as Error).message}`, {
				hint: 'Pass a JSON object, e.g. --args \'{"query":"report"}\'.',
			});
		}

		if (typeof parsedArgs !== 'object' || parsedArgs === null || Array.isArray(parsedArgs)) {
			return fail('--args must be a JSON object.', {
				hint: 'e.g. --args \'{"query":"report"}\', not a list or bare value.',
			});
		}

		args = parsedArgs as Record<string, unknown>;
	}

	const target = await resolveRef(ref);

	const client = 'configured' in target
		? await connectConfiguredServer(target.configured)
		: await connect(target.remote.id, target.token.accessToken);
	try {
		const result = (await callTool(client, toolName, args)) as {
			content?: {type: string; text?: string}[];
			structuredContent?: unknown;
			isError?: boolean;
		};

		if (full) {
			return await emit(result);
		}

		// Slim: prefer structuredContent; otherwise fall back to text content.
		if (result?.structuredContent !== undefined) {
			return await emit(result.structuredContent);
		}

		const text = (result?.content ?? [])
			.filter((c) => c.type === 'text' && c.text !== undefined)
			.map((c) => c.text)
			.join('\n');
		const nonText = (result?.content ?? []).filter((c) => c.type !== 'text');
		if (nonText.length > 0) {
			// Non-text content (images, resources, ...) has no slim form — return it.
			return await emit({content: result.content, isError: result.isError ?? false});
		}

		return await emit(text);
	} finally {
		await client.close();
	}
}

async function handleError(err: unknown): Promise<number> {
	// Broken pipe (e.g. `call-mcp ... | head`) is normal — exit quietly, code 0.
	if (err instanceof BrokenPipe) {
		return 0;
	}

	if (err instanceof ConnectorAuthError) {
		return fail(err.message, {
			authUrl: err.authUrl,
			hint: 'Open authUrl to connect or re-authorize this connector in claude.ai settings.',
		});
	}

	if (err instanceof AuthError) {
		return fail(err.message, {hint: 'See `call-mcp --help` (AUTH section).'});
	}

	if (err instanceof ServersConfigError) {
		return fail(err.message, {hint: 'See `call-mcp --help` (CONFIGURING SERVERS section) for the expected config shape.'});
	}

	if (err instanceof DiscoveryError) {
		// DiscoveryError messages already include the recovery step.
		return fail(err.message);
	}

	return fail(err instanceof Error ? err.message : String(err));
}

// A reader closing the pipe early (EPIPE) can emit an 'error' event on the
// stdout socket itself, before any write callback runs. Swallow that case so
// it doesn't crash as an unhandled error; other stdout errors still throw.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
	if (err.code === 'EPIPE') {
		process.exit(0);
	}

	throw err;
});

// Sets process.exitCode rather than calling process.exit(), so Node drains
// stdout before exiting — process.exit() would truncate large JSON payloads.
void main(process.argv.slice(2))
	.catch(handleError)
	.then((code) => {
		process.exitCode = code;
	});
