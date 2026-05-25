import {
	describe, test, expect, afterEach, vi,
} from 'vitest';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {
	expandEnv, ServersConfigError, serversConfigPaths, parseConfiguredServers,
} from './config-servers.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

/** Builds a literal \${NAME} placeholder string (as written in config files). */
const placeholder = (name: string) => `\${${name}}`;

describe('parseConfiguredServers', () => {
	const path = '/tmp/servers.json';

	test('parses an http server', () => {
		const servers = parseConfiguredServers(JSON.stringify({
			mcpServers: {
				homelab: {type: 'http', url: 'https://mcp.example.com/mcp', headers: {Authorization: 'Bearer x'}},
			},
		}), path);

		expect(servers).toEqual([{
			id: 'homelab',
			display_name: 'homelab',
			url: 'https://mcp.example.com/mcp',
			source: 'config',
			configPath: path,
			config: {
				type: 'http', url: 'https://mcp.example.com/mcp', headers: {Authorization: 'Bearer x'},
			},
		}]);
	});

	test('parses a stdio server and summarises the command as the url', () => {
		const servers = parseConfiguredServers(JSON.stringify({
			mcpServers: {
				everything: {type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything']},
			},
		}), path);

		expect(servers[0]).toMatchObject({
			id: 'everything',
			display_name: 'everything',
			url: 'npx -y @modelcontextprotocol/server-everything',
			config: {type: 'stdio', command: 'npx'},
		});
	});

	test('infers the type from url / command when not given', () => {
		const servers = parseConfiguredServers(JSON.stringify({
			mcpServers: {
				a: {url: 'https://a.example.com/mcp'},
				b: {command: 'b-server'},
			},
		}), path);

		expect(servers.map((s) => s.config.type)).toEqual(['http', 'stdio']);
	});

	test('rejects the legacy sse transport with a clear error', () => {
		expect(() => parseConfiguredServers(JSON.stringify({
			mcpServers: {legacy: {type: 'sse', url: 'https://legacy.example.com/sse'}},
		}), path)).toThrowError(/sse.*not support/i);
	});

	test('rejects unknown transport types', () => {
		expect(() => parseConfiguredServers(JSON.stringify({
			mcpServers: {odd: {type: 'websocket', url: 'wss://odd.example.com'}},
		}), path)).toThrowError(ServersConfigError);
	});

	test('rejects an http server without a url', () => {
		expect(() => parseConfiguredServers(JSON.stringify({
			mcpServers: {broken: {type: 'http'}},
		}), path)).toThrowError(/missing "url"/);
	});

	test('rejects a stdio server without a command', () => {
		expect(() => parseConfiguredServers(JSON.stringify({
			mcpServers: {broken: {type: 'stdio'}},
		}), path)).toThrowError(/missing "command"/);
	});

	test('rejects a server entry that is not an object', () => {
		expect(() => parseConfiguredServers(JSON.stringify({
			mcpServers: {broken: 'not-an-object'},
		}), path)).toThrowError(/expected object/);
	});

	test('rejects a file without an mcpServers object', () => {
		expect(() => parseConfiguredServers(JSON.stringify({servers: {}}), path)).toThrowError(/"mcpServers" object/);
	});

	test('rejects invalid JSON', () => {
		expect(() => parseConfiguredServers('not json', path)).toThrowError(/could not parse/i);
	});
});

describe('expandEnv', () => {
	test('expands placeholder variables from the environment', () => {
		vi.stubEnv('CALL_MCP_TEST_TOKEN', 'secret-value');
		expect(expandEnv(`Bearer ${placeholder('CALL_MCP_TEST_TOKEN')}`)).toBe('Bearer secret-value');
	});

	test('leaves unknown variables as-is', () => {
		expect(expandEnv(`Bearer ${placeholder('CALL_MCP_TEST_UNSET_VAR')}`)).toBe(`Bearer ${placeholder('CALL_MCP_TEST_UNSET_VAR')}`);
	});

	test('recurses through objects and arrays', () => {
		vi.stubEnv('CALL_MCP_TEST_TOKEN', 'tok');
		expect(expandEnv({
			headers: {Authorization: `Bearer ${placeholder('CALL_MCP_TEST_TOKEN')}`},
			args: ['--token', placeholder('CALL_MCP_TEST_TOKEN')],
			port: 8080,
		})).toEqual({
			headers: {Authorization: 'Bearer tok'},
			args: ['--token', 'tok'],
			port: 8080,
		});
	});
});

describe('serversConfigPaths', () => {
	test('uses only CALL_MCP_SERVERS_FILE when set', () => {
		vi.stubEnv('CALL_MCP_SERVERS_FILE', '/somewhere/custom.json');
		expect(serversConfigPaths()).toEqual(['/somewhere/custom.json']);
	});

	test('falls back to the XDG config location', () => {
		vi.stubEnv('CALL_MCP_SERVERS_FILE', '');
		vi.stubEnv('XDG_CONFIG_HOME', '');
		expect(serversConfigPaths()).toEqual([join(homedir(), '.config', 'call-mcp', 'servers.json')]);
	});

	test('respects XDG_CONFIG_HOME', () => {
		vi.stubEnv('CALL_MCP_SERVERS_FILE', '');
		vi.stubEnv('XDG_CONFIG_HOME', '/xdg');
		expect(serversConfigPaths()).toEqual([join('/xdg', 'call-mcp', 'servers.json')]);
	});
});
