import {
	describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import {execFileSync, execFile} from 'node:child_process';
import {createServer, type Server} from 'node:http';
import {existsSync} from 'node:fs';
import {type AddressInfo} from 'node:net';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'dist', 'cli.js');

/**
 * End-to-end tests: spawn the real `call-mcp` binary as a subprocess and assert on
 * its external contract — argv in, JSON on stdout, exit code out. The two
 * Anthropic HTTP endpoints (the discovery API and the MCP proxy) are replaced
 * with a local mock via the TEST_ONLY_*_URL_OVERRIDE env vars, so no real
 * account or network is needed.
 */

const SERVERS = [
	{
		type: 'mcp_server',
		id: 'mcpsrv_aggregator',
		display_name: 'Aggregator',
		url: 'https://mcp.example.com/mcp',
		created_at: '2026-03-04T15:33:05Z',
		tools: null,
	},
	{
		type: 'mcp_server',
		id: 'mcpsrv_needsauth',
		display_name: 'Needs Auth',
		url: 'https://needsauth.example.com/mcp',
		created_at: '2026-01-01T00:00:00Z',
		tools: null,
	},
];

const TOOLS = [
	{
		name: 'echo',
		description: 'Echoes the message back.',
		inputSchema: {
			type: 'object',
			properties: {message: {type: 'string'}},
			required: ['message'],
		},
	},
	{
		name: 'get_profile',
		description: 'Returns a fixed profile object.',
		inputSchema: {type: 'object', properties: {}},
	},
];

/** Builds the JSON-RPC response for a request the mock proxy understands. */
function handleRpc(body: {id?: unknown; method?: string; params?: any}): unknown | undefined {
	switch (body.method) {
		case 'initialize':
			return {
				jsonrpc: '2.0',
				id: body.id,
				result: {
					protocolVersion: '2025-06-18',
					capabilities: {tools: {}},
					serverInfo: {name: 'mock-server', version: '1.0.0'},
				},
			};
		case 'notifications/initialized':
			return undefined; // A notification — no response body.
		case 'tools/list':
			return {jsonrpc: '2.0', id: body.id, result: {tools: TOOLS}};
		case 'tools/call': {
			const name = body.params?.name as string;
			if (name === 'echo') {
				const message = body.params?.arguments?.message ?? '';
				return {
					jsonrpc: '2.0',
					id: body.id,
					result: {content: [{type: 'text', text: String(message)}]},
				};
			}

			if (name === 'get_profile') {
				return {
					jsonrpc: '2.0',
					id: body.id,
					result: {
						content: [{type: 'text', text: '{"email":"test@example.com"}'}],
						structuredContent: {email: 'test@example.com'},
					},
				};
			}

			return {
				jsonrpc: '2.0',
				id: body.id,
				error: {code: -32_602, message: `Unknown tool: ${name}`},
			};
		}

		case undefined:
		default:
			return {
				jsonrpc: '2.0',
				id: body.id,
				error: {code: -32_601, message: `Method not found: ${body.method}`},
			};
	}
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
	// The e2e tests drive the built binary, so make sure it exists.
	if (!existsSync(cliPath)) {
		execFileSync('npm', ['run', 'build'], {cwd: join(here, '..'), stdio: 'inherit'});
	}

	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c as Buffer));
		req.on('end', () => {
			const url = req.url ?? '';

			// Discovery API: GET /v1/mcp_servers
			if (req.method === 'GET' && url.startsWith('/v1/mcp_servers')) {
				res.writeHead(200, {'content-type': 'application/json'});
				res.end(JSON.stringify({data: SERVERS, next_page: null}));
				return;
			}

			// MCP proxy: POST /v1/mcp/{server_id}
			if (req.method === 'POST' && url.startsWith('/v1/mcp/')) {
				const serverId = url.slice('/v1/mcp/'.length);

				// This connector is configured to require its own authorization.
				if (serverId === 'mcpsrv_needsauth') {
					res.writeHead(401, {'content-type': 'application/json'});
					res.end(JSON.stringify({
						type: 'error',
						error: {
							type: 'authentication_error',
							message: 'MCP server requires authentication but no OAuth token is configured.',
							details: {error_code: 'mcp_unauthorized_no_token'},
						},
					}));
					return;
				}

				const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
				const rpcResponse = handleRpc(body);
				if (rpcResponse === undefined) {
					res.writeHead(202).end();
					return;
				}

				res.writeHead(200, {'content-type': 'application/json'});
				res.end(JSON.stringify(rpcResponse));
				return;
			}

			res.writeHead(404).end();
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const {port} = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	// `call-mcp` uses fetch with keep-alive, so sockets to the mock may still be
	// open. server.close() alone would wait for them to drain (hanging the
	// test worker); closeAllConnections() drops them so close() can finish.
	server.closeAllConnections();
	await new Promise<void>((resolve) => {
		server.close(() => {
			resolve();
		});
	});
});

type RunResult = {stdout: string; stderr: string; status: number; json: any};

/**
 * Runs `call-mcp <args>` against the mock server and parses its stdout as JSON.
 *
 * Uses async execFile, not spawnSync: the mock HTTP server runs in this same
 * process, so a synchronous spawn would block the event loop and deadlock —
 * the child could never connect to a server whose loop is frozen.
 */
async function runMcpc(args: string[], envOverrides: Record<string, string> = {}, stdin?: string): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = execFile(
			'node',
			[cliPath, ...args],
			{
				encoding: 'utf8',
				// Default is 1MB; the large-payload stdin test echoes ~2MB back.
				maxBuffer: 16 * 1024 * 1024,
				env: {
					...process.env,
					CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-e2e-fixture',
					TEST_ONLY_API_URL_OVERRIDE: baseUrl,
					TEST_ONLY_PROXY_URL_OVERRIDE: baseUrl,
					...envOverrides,
				},
			},
			(err, stdout, stderr) => {
				let json: unknown;
				try {
					json = JSON.parse(stdout);
				} catch {
					json = undefined;
				}

				resolve({
					stdout,
					stderr,
					status: err ? ((err as {code?: number}).code ?? 1) : 0,
					json,
				});
			},
		);
		if (stdin !== undefined) {
			child.stdin?.end(stdin);
		}
	});
}

describe('list', () => {
	test('prints a slim array of servers', async () => {
		const {json, status} = await runMcpc(['list']);
		expect(status).toBe(0);
		expect(json).toEqual([
			{
				id: 'mcpsrv_aggregator', display_name: 'Aggregator', url: 'https://mcp.example.com/mcp', source: 'claude.ai',
			},
			{
				id: 'mcpsrv_needsauth', display_name: 'Needs Auth', url: 'https://needsauth.example.com/mcp', source: 'claude.ai',
			},
		]);
	});

	test('--full includes the raw server fields', async () => {
		const {json, status} = await runMcpc(['list', '--full']);
		expect(status).toBe(0);
		expect(json[0]).toMatchObject({
			type: 'mcp_server',
			id: 'mcpsrv_aggregator',
			created_at: '2026-03-04T15:33:05Z',
		});
	});
});

describe('tools', () => {
	test('resolves a server by name and lists its tools (slim)', async () => {
		const {json, status} = await runMcpc(['tools', 'Aggregator']);
		expect(status).toBe(0);
		expect(json.server).toMatchObject({id: 'mcpsrv_aggregator', display_name: 'Aggregator'});
		expect(json.tools).toEqual([
			{name: 'echo', description: 'Echoes the message back.'},
			{name: 'get_profile', description: 'Returns a fixed profile object.'},
		]);
	});

	test('resolves a server by id', async () => {
		const {json, status} = await runMcpc(['tools', 'mcpsrv_aggregator']);
		expect(status).toBe(0);
		expect(json.server.id).toBe('mcpsrv_aggregator');
	});

	test('resolves a server by case-insensitive prefix', async () => {
		const {json, status} = await runMcpc(['tools', 'agg']);
		expect(status).toBe(0);
		expect(json.server.id).toBe('mcpsrv_aggregator');
	});

	test('--full includes tool input schemas', async () => {
		const {json, status} = await runMcpc(['tools', 'Aggregator', '--full']);
		expect(status).toBe(0);
		expect(json.tools[0]).toMatchObject({
			name: 'echo',
			inputSchema: {type: 'object'},
		});
	});
});

describe('call', () => {
	test('slim output returns the text content of a tool result', async () => {
		const {json, status} = await runMcpc([
			'call', 'Aggregator', 'echo', '--args', '{"message":"hello e2e"}',
		]);
		expect(status).toBe(0);
		expect(json).toBe('hello e2e');
	});

	test('slim output prefers structuredContent when present', async () => {
		const {json, status} = await runMcpc(['call', 'Aggregator', 'get_profile']);
		expect(status).toBe(0);
		expect(json).toEqual({email: 'test@example.com'});
	});

	test('--full returns the complete tool-call result envelope', async () => {
		const {json, status} = await runMcpc(['call', 'Aggregator', 'get_profile', '--full']);
		expect(status).toBe(0);
		expect(json).toMatchObject({
			content: [{type: 'text'}],
			structuredContent: {email: 'test@example.com'},
		});
	});

	test('--args - reads the JSON object from stdin', async () => {
		const {json, status} = await runMcpc(
			['call', 'Aggregator', 'echo', '--args', '-'],
			{},
			'{"message":"from stdin"}',
		);
		expect(status).toBe(0);
		expect(json).toBe('from stdin');
	});

	test('--args - handles a large payload that would exceed the argv size limit', async () => {
		// ~2MB of JSON — far past ARG_MAX, so this can only work via stdin.
		const big = 'x'.repeat(2_000_000);
		const {json, status} = await runMcpc(
			['call', 'Aggregator', 'echo', '--args', '-'],
			{},
			JSON.stringify({message: big}),
		);
		expect(status).toBe(0);
		expect(json).toBe(big);
	});

	test('--args - with empty stdin fails clearly', async () => {
		const {json, status} = await runMcpc(['call', 'Aggregator', 'echo', '--args', '-'], {}, '');
		expect(status).toBe(1);
		expect(json.error).toMatch(/stdin was empty/i);
	});

	test('--args - with invalid JSON on stdin fails clearly', async () => {
		const {json, status} = await runMcpc(['call', 'Aggregator', 'echo', '--args', '-'], {}, 'not json');
		expect(status).toBe(1);
		expect(json.error).toMatch(/not valid json/i);
	});
});

describe('errors are JSON on stdout with a non-zero exit', () => {
	test('unknown command', async () => {
		const {json, status, stderr} = await runMcpc(['frobnicate']);
		expect(status).toBe(1);
		expect(stderr).toBe('');
		expect(json.error).toMatch(/unknown command/i);
	});

	test('unknown server reference', async () => {
		const {json, status} = await runMcpc(['tools', 'nonexistent']);
		expect(status).toBe(1);
		expect(json.error).toMatch(/no mcp server matches/i);
	});

	test('invalid --args JSON', async () => {
		const {json, status} = await runMcpc(['call', 'Aggregator', 'echo', '--args', 'not json']);
		expect(status).toBe(1);
		expect(json.error).toMatch(/not valid json/i);
	});

	test('--args that is not an object', async () => {
		const {json, status} = await runMcpc(['call', 'Aggregator', 'echo', '--args', '[1,2,3]']);
		expect(status).toBe(1);
		expect(json.error).toMatch(/must be a json object/i);
	});

	test('a connector that needs its own authorization includes an authUrl', async () => {
		const {json, status} = await runMcpc(['tools', 'Needs Auth']);
		expect(status).toBe(1);
		expect(json.error).toMatch(/requires authentication/i);
		expect(json.authUrl).toBe('https://claude.ai/customize/connectors');
	});

	test('missing token produces a JSON auth error, not a crash', async () => {
		// Run with no env-var token and a config dir that has no credentials file.
		const {stdout, stderr} = await runMcpc(['list'], {
			CLAUDE_CODE_OAUTH_TOKEN: '',
			CLAUDE_CONFIG_DIR: join(here, '..', 'this-dir-does-not-exist'),
		});
		// On macOS the Keychain may still hold a real token, so don't assert the
		// exact error — only the crash-free contract: valid JSON out, never a
		// stack trace on stderr.
		expect(stderr).not.toMatch(/\n\s+at\s/); // no stack trace
		expect(() => JSON.parse(stdout)).not.toThrow();
	});
});

describe('help', () => {
	test('`call-mcp help` prints usage and exits 0', async () => {
		const {stdout, status} = await runMcpc(['help']);
		expect(status).toBe(0);
		expect(stdout).toMatch(/^call-mcp — a CLI for calling MCP servers/);
		expect(stdout).toContain('USAGE');
		expect(stdout).toContain('EXAMPLES');
	});

	test('--help is equivalent to help', async () => {
		const {stdout, status} = await runMcpc(['--help']);
		expect(status).toBe(0);
		expect(stdout).toMatch(/^call-mcp — a CLI for calling MCP servers/);
	});
});
