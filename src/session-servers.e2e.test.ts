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

/**
 * End-to-end tests for Claude Code cloud session servers: spawn the real
 * `call-mcp` binary with CALL_MCP_SESSION_CONFIG pointing at a fixture of the
 * session's launch config, against an in-process MCP Streamable HTTP mock
 * that (like the real per-session route) rejects requests without the session
 * ingress token. No real session or network is needed.
 */

const TOKEN_A = 'session-ingress-token-a';
const TOKEN_B = 'session-ingress-token-b';

let tempDir: string;
let httpServer: Server;
let httpBaseUrl: string;
let sessionConfigPath: string;
let tokenPath: string;
let userConfigPath: string;
/** The token the mock currently accepts. */
let acceptedToken = TOKEN_A;

beforeAll(async () => {
	if (!existsSync(cliPath)) {
		execFileSync('npm', ['run', 'build'], {cwd: join(here, '..'), stdio: 'inherit'});
	}

	tempDir = await mkdtemp(join(tmpdir(), 'call-mcp-session-e2e-'));

	httpServer = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c as Buffer));
		req.on('end', () => {
			if (req.headers.authorization !== `Bearer ${acceptedToken}`) {
				res.writeHead(401, {'content-type': 'text/plain'}).end('authentication required\n');
				return;
			}

			if (req.method !== 'POST') {
				res.writeHead(405).end();
				return;
			}

			const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {id?: unknown; method?: string};
			const respond = (result: unknown) => {
				res.writeHead(200, {'content-type': 'application/json'});
				res.end(JSON.stringify({jsonrpc: '2.0', id: body.id, result}));
			};

			switch (body.method) {
				case 'initialize':
					respond({
						protocolVersion: '2025-06-18',
						capabilities: {tools: {}},
						serverInfo: {name: 'session-fixture', version: '1.0.0'},
					});
					return;
				case 'tools/list':
					respond({tools: [{name: 'whoami', description: 'Reports the session headers received.', inputSchema: {type: 'object'}}]});
					return;
				case 'tools/call':
					respond({
						content: [{type: 'text', text: 'ok'}],
						structuredContent: {
							authorization: req.headers.authorization,
							sessionUuid: req.headers['x-session-uuid'] ?? null,
						},
					});
					return;
				case undefined:
				default:
					res.writeHead(202).end();
			}
		});
	});

	await new Promise<void>((resolve) => {
		httpServer.listen(0, '127.0.0.1', resolve);
	});
	const {port} = httpServer.address() as AddressInfo;
	httpBaseUrl = `http://127.0.0.1:${port}`;

	// Mirrors /tmp/mcp-config-<session id>.json: http servers with routing
	// headers, a per-tool permission list, and no Authorization header.
	sessionConfigPath = join(tempDir, 'mcp-config-cse_e2e.json');
	await writeFile(sessionConfigPath, JSON.stringify({
		mcpServers: {
			Aggregator: {
				url: `${httpBaseUrl}/v2/ccr-sessions/cse_e2e/mcp?mcp_server_id=a`,
				type: 'http',
				headers: {'X-MCP-Server-ID': 'srv-a', 'X-Session-UUID': 'cse_e2e'},
				tools: [{name: 'whoami', permission_policy: 'always_allow'}],
			},
			'claude-code-remote': {
				url: `${httpBaseUrl}/v2/ccr-sessions/cse_e2e/mcp?mcp_server_id=b`,
				type: 'http',
				headers: {'X-MCP-Server-ID': 'srv-b', 'X-Session-UUID': 'cse_e2e'},
			},
		},
	}));

	tokenPath = join(tempDir, '.session_ingress_token');
	await writeFile(tokenPath, `${TOKEN_A}\n`);

	// A user config with a server named like a session server, to check precedence.
	userConfigPath = join(tempDir, 'servers.json');
	await writeFile(userConfigPath, JSON.stringify({
		mcpServers: {aggregator: {type: 'http', url: 'https://mine.example.com/mcp'}},
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

async function runCli(args: string[], envOverrides: Record<string, string> = {}): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			'node',
			[cliPath, ...args],
			{
				encoding: 'utf8',
				env: {
					...process.env,
					// No Claude Code login, as inside a cloud session (discovery can't be used there).
					CLAUDE_CODE_OAUTH_TOKEN: '',
					CLAUDE_CONFIG_DIR: join(tempDir, 'no-claude-config'),
					CALL_MCP_SERVERS_FILE: join(tempDir, 'no-servers.json'),
					CALL_MCP_SESSION_CONFIG: sessionConfigPath,
					CLAUDE_SESSION_INGRESS_TOKEN_FILE: tokenPath,
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
					stdout, stderr, status: err ? ((err as {code?: number}).code ?? 1) : 0, json,
				});
			},
		);
	});
}

describe('list with session servers', () => {
	test('lists them with source: "session", without a Claude Code login', async () => {
		const {json, status, stderr} = await runCli(['list']);
		expect(status).toBe(0);
		expect(json).toEqual([
			{
				id: 'Aggregator', display_name: 'Aggregator', url: `${httpBaseUrl}/v2/ccr-sessions/cse_e2e/mcp?mcp_server_id=a`, source: 'session',
			},
			{
				id: 'claude-code-remote', display_name: 'claude-code-remote', url: `${httpBaseUrl}/v2/ccr-sessions/cse_e2e/mcp?mcp_server_id=b`, source: 'session',
			},
		]);
		expect(stderr).toMatch(/skipping claude\.ai connectors/i);
	});

	test('--full never includes the session token', async () => {
		const {stdout, json, status} = await runCli(['list', '--full']);
		expect(status).toBe(0);
		expect(stdout).not.toContain(TOKEN_A);
		expect(json[0].config.headers).toEqual({'X-MCP-Server-ID': 'srv-a', 'X-Session-UUID': 'cse_e2e'});
	});

	test('outside a session there are none', async () => {
		const {json} = await runCli(['list'], {CALL_MCP_SESSION_CONFIG: '', CLAUDE_CODE_REMOTE_SESSION_ID: ''});
		// Nothing left to list, and no claude.ai login: the auth error surfaces.
		expect(json.error).toMatch(/credentials/i);
	});

	test('a config-file server shadows a same-named session server', async () => {
		const {json, status} = await runCli(['list'], {CALL_MCP_SERVERS_FILE: userConfigPath});
		expect(status).toBe(0);
		expect(json.map((s: {id: string; source: string}) => `${s.source}:${s.id}`)).toEqual(['config:aggregator', 'session:claude-code-remote']);
	});
});

describe('calling session servers', () => {
	test('tools lists the fixture tool (resolved by prefix)', async () => {
		const {json, status} = await runCli(['tools', 'agg']);
		expect(status).toBe(0);
		expect(json.server).toEqual({id: 'Aggregator', display_name: 'Aggregator'});
		expect(json.tools).toEqual([{name: 'whoami', description: 'Reports the session headers received.'}]);
	});

	test('call sends the session token and the routing headers', async () => {
		const {json, status} = await runCli(['call', 'Aggregator', 'whoami']);
		expect(status).toBe(0);
		expect(json).toEqual({authorization: `Bearer ${TOKEN_A}`, sessionUuid: 'cse_e2e'});
	});

	test('re-reads the token file on each invocation, so a rotated token is picked up', async () => {
		acceptedToken = TOKEN_B;
		await writeFile(tokenPath, TOKEN_B);
		try {
			const {json, status} = await runCli(['call', 'Aggregator', 'whoami']);
			expect(status).toBe(0);
			expect(json.authorization).toBe(`Bearer ${TOKEN_B}`);
		} finally {
			acceptedToken = TOKEN_A;
			await writeFile(tokenPath, TOKEN_A);
		}
	});

	test('a missing token file fails with a clear JSON error', async () => {
		const {json, status} = await runCli(['tools', 'Aggregator'], {CLAUDE_SESSION_INGRESS_TOKEN_FILE: join(tempDir, 'missing-token')});
		expect(status).toBe(1);
		expect(json.error).toMatch(/could not read its token file .*missing-token/i);
	});

	test('a rejected token fails with a session-specific hint, not an OAuth browser flow', async () => {
		const badToken = join(tempDir, 'bad-token');
		await writeFile(badToken, 'not-the-token');
		const {json, status} = await runCli(['tools', 'Aggregator'], {CLAUDE_SESSION_INGRESS_TOKEN_FILE: badToken});
		expect(status).toBe(1);
		expect(json.error).toMatch(/authentication required/);
		expect(json.error).toMatch(/only work inside the Claude Code cloud session/);
	});
});
