import {
	describe, test, expect, afterEach, beforeAll, afterAll, vi,
} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ServersConfigError} from './config-servers.js';
import {loadSessionServers, sessionConfigPath, sessionTokenPath} from './session-servers.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

/** The shape a Claude Code cloud session writes, including the per-tool permission list call-mcp ignores. */
const SESSION_CONFIG = {
	mcpServers: {
		Aggregator: {
			url: 'https://api.anthropic.com/v2/ccr-sessions/cse_123/mcp?mcp_server_id=a&mcp_url=https%3A%2F%2Fmcp.example.com%2Fmcp',
			type: 'http',
			headers: {'X-MCP-Server-ID': 'srv-a', 'X-Session-UUID': 'cse_123'},
			tools: [{name: 'gmail__get_profile', permission_policy: 'always_allow'}],
		},
	},
};

let tempDir: string;
let configPath: string;

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'call-mcp-session-'));
	configPath = join(tempDir, 'mcp-config-cse_123.json');
	await writeFile(configPath, JSON.stringify(SESSION_CONFIG));
});

afterAll(async () => {
	await rm(tempDir, {recursive: true, force: true});
});

describe('sessionConfigPath', () => {
	test('is derived from the session id', () => {
		vi.stubEnv('CALL_MCP_SESSION_CONFIG', '');
		vi.stubEnv('CLAUDE_CODE_REMOTE_SESSION_ID', 'cse_01Abc');
		expect(sessionConfigPath()).toBe('/tmp/mcp-config-cse_01Abc.json');
	});

	test('is undefined outside a session', () => {
		vi.stubEnv('CALL_MCP_SESSION_CONFIG', '');
		vi.stubEnv('CLAUDE_CODE_REMOTE_SESSION_ID', '');
		expect(sessionConfigPath()).toBeUndefined();
	});

	test('ignores session ids that are not plain tokens', () => {
		vi.stubEnv('CALL_MCP_SESSION_CONFIG', '');
		vi.stubEnv('CLAUDE_CODE_REMOTE_SESSION_ID', '../etc/passwd');
		expect(sessionConfigPath()).toBeUndefined();
	});

	test('CALL_MCP_SESSION_CONFIG overrides detection', () => {
		vi.stubEnv('CALL_MCP_SESSION_CONFIG', '/custom/session.json');
		vi.stubEnv('CLAUDE_CODE_REMOTE_SESSION_ID', 'cse_01Abc');
		expect(sessionConfigPath()).toBe('/custom/session.json');
	});
});

describe('sessionTokenPath', () => {
	test('uses CLAUDE_SESSION_INGRESS_TOKEN_FILE when set', () => {
		vi.stubEnv('CLAUDE_SESSION_INGRESS_TOKEN_FILE', '/custom/token');
		expect(sessionTokenPath()).toBe('/custom/token');
	});

	test('falls back to the default location', () => {
		vi.stubEnv('CLAUDE_SESSION_INGRESS_TOKEN_FILE', '');
		expect(sessionTokenPath()).toBe('/home/claude/.claude/remote/.session_ingress_token');
	});
});

describe('loadSessionServers', () => {
	test('maps the session config to session-sourced http servers with a token file', async () => {
		vi.stubEnv('CALL_MCP_SESSION_CONFIG', configPath);
		vi.stubEnv('CLAUDE_SESSION_INGRESS_TOKEN_FILE', '/run/token');

		const servers = await loadSessionServers();
		expect(servers).toEqual([{
			id: 'Aggregator',
			display_name: 'Aggregator',
			url: SESSION_CONFIG.mcpServers.Aggregator.url,
			source: 'session',
			configPath,
			tokenFile: '/run/token',
			config: {
				type: 'http',
				url: SESSION_CONFIG.mcpServers.Aggregator.url,
				headers: SESSION_CONFIG.mcpServers.Aggregator.headers,
			},
		}]);
	});

	test('returns [] when the detected config file does not exist', async () => {
		vi.stubEnv('CALL_MCP_SESSION_CONFIG', '');
		vi.stubEnv('CLAUDE_CODE_REMOTE_SESSION_ID', 'cse_does_not_exist_for_tests');
		expect(await loadSessionServers()).toEqual([]);
	});

	test('errors when an explicit CALL_MCP_SESSION_CONFIG does not exist', async () => {
		vi.stubEnv('CALL_MCP_SESSION_CONFIG', join(tempDir, 'missing.json'));
		await expect(loadSessionServers()).rejects.toThrow(ServersConfigError);
	});
});
