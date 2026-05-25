import {
	describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import {execFileSync, execFile} from 'node:child_process';
import {createServer, type Server} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {type AddressInfo} from 'node:net';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'dist', 'cli.js');

/** Builds a literal \${NAME} placeholder string (as written in config files). */
const envPlaceholder = (name: string) => `\${${name}}`;

/**
 * End-to-end tests for configured servers: spawn the real `call-mcp`
 * binary with CALL_MCP_SERVERS_FILE pointing at a temp config, against
 * (a) a stdio fixture server spawned by the CLI itself, and (b) an in-process
 * MCP Streamable HTTP mock. No real account or network is needed.
 */

/**
 * A minimal stdio MCP server used as the spawn target: newline-delimited
 * JSON-RPC on stdin/stdout, one `echo` tool. It also reports the value of
 * FIXTURE_ENV_VAR so tests can assert that configured env vars (and their
 * ${VAR} expansion) reach the spawned process.
 */
const STDIO_FIXTURE = `
import {createInterface} from 'node:readline';

const respond = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const rl = createInterface({input: process.stdin});

rl.on('line', (line) => {
	if (!line.trim()) {
		return;
	}

	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}

	if (msg.method === 'initialize') {
		respond({jsonrpc: '2.0', id: msg.id, result: {
			protocolVersion: '2025-06-18',
			capabilities: {tools: {}},
			serverInfo: {name: 'stdio-fixture', version: '1.0.0'},
		}});
	} else if (msg.method === 'tools/list') {
		respond({jsonrpc: '2.0', id: msg.id, result: {tools: [{
			name: 'echo',
			description: 'Echoes the message back.',
			inputSchema: {type: 'object', properties: {message: {type: 'string'}}},
		}]}});
	} else if (msg.method === 'tools/call') {
		const message = msg.params?.arguments?.message ?? '';
		respond({jsonrpc: '2.0', id: msg.id, result: {
			content: [{type: 'text', text: String(message)}],
			structuredContent: {echoed: message, fixtureEnv: process.env.FIXTURE_ENV_VAR ?? null},
		}});
	} else if (msg.id !== undefined) {
		respond({jsonrpc: '2.0', id: msg.id, error: {code: -32601, message: 'Method not found: ' + msg.method}});
	}
});
`;

const HTTP_TOOLS = [
	{
		name: 'whoami',
		description: 'Returns the Authorization-style header the server received.',
		inputSchema: {type: 'object', properties: {}},
	},
];

let tempDir: string;
let httpServer: Server;
let httpBaseUrl: string;
let goodConfigPath: string;
let sseConfigPath: string;
let stdioOnlyConfigPath: string;

beforeAll(async () => {
	// The e2e tests drive the built binary, so make sure it exists.
	if (!existsSync(cliPath)) {
		execFileSync('npm', ['run', 'build'], {cwd: join(here, '..'), stdio: 'inherit'});
	}

	tempDir = await mkdtemp(join(tmpdir(), 'call-mcp-config-e2e-'));
	const fixturePath = join(tempDir, 'stdio-fixture.mjs');
	await writeFile(fixturePath, STDIO_FIXTURE);

	// An MCP Streamable HTTP mock plus a stub of the claude.ai discovery API
	// (returning no connectors) so `list` can run without a real account.
	httpServer = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c as Buffer));
		req.on('end', () => {
			const url = req.url ?? '';

			if (req.method === 'GET' && url.startsWith('/v1/mcp_servers')) {
				res.writeHead(200, {'content-type': 'application/json'});
				res.end(JSON.stringify({data: [], next_page: null}));
				return;
			}

			if (url.startsWith('/mcp')) {
				if (req.method === 'GET') {
					// No server-initiated stream support — the SDK client tolerates this.
					res.writeHead(405).end();
					return;
				}

				if (req.method === 'DELETE') {
					res.writeHead(200).end();
					return;
				}

				const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
					id?: unknown; method?: string; params?: {name?: string; arguments?: Record<string, unknown>};
				};
				const respond = (payload: unknown) => {
					res.writeHead(200, {'content-type': 'application/json'});
					res.end(JSON.stringify(payload));
				};

				switch (body.method) {
					case 'initialize':
						respond({
							jsonrpc: '2.0',
							id: body.id,
							result: {
								protocolVersion: '2025-06-18',
								capabilities: {tools: {}},
								serverInfo: {name: 'http-fixture', version: '1.0.0'},
							},
						});
						return;
					case 'tools/list':
						respond({jsonrpc: '2.0', id: body.id, result: {tools: HTTP_TOOLS}});
						return;
					case 'tools/call':
						respond({
							jsonrpc: '2.0',
							id: body.id,
							result: {
								content: [{type: 'text', text: 'ok'}],
								structuredContent: {receivedAuthHeader: req.headers['x-test-auth'] ?? null},
							},
						});
						return;
					case undefined:
					default:
						// Notifications get an empty 202.
						res.writeHead(202).end();
				}

				return;
			}

			res.writeHead(404).end();
		});
	});

	await new Promise<void>((resolve) => {
		httpServer.listen(0, '127.0.0.1', resolve);
	});
	const {port} = httpServer.address() as AddressInfo;
	httpBaseUrl = `http://127.0.0.1:${port}`;

	goodConfigPath = join(tempDir, 'servers.json');
	await writeFile(goodConfigPath, JSON.stringify({
		mcpServers: {
			'echo-stdio': {
				type: 'stdio',
				command: process.execPath,
				args: [fixturePath],
				env: {FIXTURE_ENV_VAR: envPlaceholder('E2E_FIXTURE_VALUE')},
			},
			'echo-http': {
				type: 'http',
				url: `${httpBaseUrl}/mcp`,
				headers: {'X-Test-Auth': `Bearer ${envPlaceholder('E2E_HTTP_TOKEN')}`},
			},
		},
	}));

	sseConfigPath = join(tempDir, 'servers-sse.json');
	await writeFile(sseConfigPath, JSON.stringify({
		mcpServers: {legacy: {type: 'sse', url: 'https://legacy.example.com/sse'}},
	}));

	stdioOnlyConfigPath = join(tempDir, 'servers-stdio-only.json');
	await writeFile(stdioOnlyConfigPath, JSON.stringify({
		mcpServers: {
			'echo-stdio': {type: 'stdio', command: process.execPath, args: [fixturePath]},
		},
	}));
});

afterAll(async () => {
	httpServer.closeAllConnections();
	await new Promise<void>((resolve) => {
		httpServer.close(() => {
			resolve();
		});
	});
	await rm(tempDir, {recursive: true, force: true});
});

type RunResult = {stdout: string; stderr: string; status: number; json: any};

/** Runs `call-mcp <args>` with the servers config and parses its stdout as JSON. */
async function runCli(args: string[], envOverrides: Record<string, string> = {}): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			'node',
			[cliPath, ...args],
			{
				encoding: 'utf8',
				env: {
					...process.env,
					CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-e2e-fixture',
					TEST_ONLY_API_URL_OVERRIDE: httpBaseUrl,
					TEST_ONLY_PROXY_URL_OVERRIDE: httpBaseUrl,
					CALL_MCP_SERVERS_FILE: goodConfigPath,
					E2E_FIXTURE_VALUE: 'expanded-fixture-value',
					E2E_HTTP_TOKEN: 'expanded-http-token',
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
	});
}

describe('list with configured servers', () => {
	test('includes configured servers with source: "config"', async () => {
		const {json, status} = await runCli(['list']);
		expect(status).toBe(0);
		expect(json).toContainEqual({
			id: 'echo-http',
			display_name: 'echo-http',
			url: `${httpBaseUrl}/mcp`,
			source: 'config',
		});
		expect(json).toContainEqual(expect.objectContaining({id: 'echo-stdio', source: 'config'}));
	});

	test('list still works without claude.ai access (connectors are skipped with a note)', async () => {
		// Point discovery at a port that refuses connections: configured servers
		// must still be listed, with a note about the skipped connectors on stderr.
		const {json, status, stderr} = await runCli(['list'], {
			TEST_ONLY_API_URL_OVERRIDE: 'http://127.0.0.1:9',
		});
		expect(status).toBe(0);
		expect(json.map((s: {id: string}) => s.id).sort()).toEqual(['echo-http', 'echo-stdio']);
		expect(json.every((s: {source: string}) => s.source === 'config')).toBe(true);
		expect(stderr).toMatch(/skipping claude\.ai connectors/i);
	});

	test('--full includes the unexpanded config', async () => {
		const {json, status} = await runCli(['list', '--full']);
		expect(status).toBe(0);
		const httpEntry = json.find((s: {id: string}) => s.id === 'echo-http');
		// ${VAR} placeholders must not be expanded in list output, so secrets stay out of it.
		expect(httpEntry.config.headers['X-Test-Auth']).toBe(`Bearer ${envPlaceholder('E2E_HTTP_TOKEN')}`);
	});
});

describe('stdio configured servers', () => {
	test('tools lists the fixture tool', async () => {
		const {json, status} = await runCli(['tools', 'echo-stdio']);
		expect(status).toBe(0);
		expect(json.server).toEqual({id: 'echo-stdio', display_name: 'echo-stdio'});
		expect(json.tools).toEqual([{name: 'echo', description: 'Echoes the message back.'}]);
	});

	test('call invokes the tool and expands configured env vars', async () => {
		const {json, status} = await runCli(['call', 'echo-stdio', 'echo', '--args', '{"message":"hi stdio"}']);
		expect(status).toBe(0);
		expect(json).toEqual({echoed: 'hi stdio', fixtureEnv: 'expanded-fixture-value'});
	});

	test('works without a Claude Code login when referenced by exact name', async () => {
		const {json, status} = await runCli(
			['call', 'echo-stdio', 'echo', '--args', '{"message":"no login"}'],
			{
				CLAUDE_CODE_OAUTH_TOKEN: '',
				CLAUDE_CONFIG_DIR: join(tempDir, 'does-not-exist'),
				CALL_MCP_SERVERS_FILE: stdioOnlyConfigPath,
			},
		);
		expect(status).toBe(0);
		expect(json.echoed).toBe('no login');
	});
});

describe('streamable http configured servers', () => {
	test('tools lists the fixture tool', async () => {
		const {json, status} = await runCli(['tools', 'echo-http']);
		expect(status).toBe(0);
		expect(json.tools).toEqual([{name: 'whoami', description: 'Returns the Authorization-style header the server received.'}]);
	});

	test('call sends configured headers with env placeholders expanded', async () => {
		const {json, status} = await runCli(['call', 'echo-http', 'whoami']);
		expect(status).toBe(0);
		expect(json).toEqual({receivedAuthHeader: 'Bearer expanded-http-token'});
	});
});

describe('servers config errors', () => {
	test('the legacy sse transport is rejected with a clear error', async () => {
		const {json, status} = await runCli(['list'], {CALL_MCP_SERVERS_FILE: sseConfigPath});
		expect(status).toBe(1);
		expect(json.error).toMatch(/sse.*not support/i);
		expect(json.hint).toMatch(/CONFIGURING SERVERS/);
	});

	test('a stdio server whose command does not exist fails with a JSON error, not a crash', async () => {
		const brokenConfig = join(tempDir, 'servers-broken.json');
		await writeFile(brokenConfig, JSON.stringify({
			mcpServers: {broken: {type: 'stdio', command: join(tempDir, 'no-such-binary')}},
		}));
		const {json, status, stderr} = await runCli(['tools', 'broken'], {CALL_MCP_SERVERS_FILE: brokenConfig});
		expect(status).toBe(1);
		expect(stderr).not.toMatch(/\n\s+at\s/); // No stack trace.
		expect(json.error).toMatch(/could not connect to server 'broken'/i);
	});
});

describe('help', () => {
	test('documents the CONFIGURING SERVERS config', async () => {
		const {stdout, status} = await runCli(['help']);
		expect(status).toBe(0);
		expect(stdout).toContain('CONFIGURING SERVERS');
		expect(stdout).toContain('CALL_MCP_SERVERS_FILE');
	});
});
