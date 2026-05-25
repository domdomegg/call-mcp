import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {getDefaultEnvironment, StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';

/** Environment variable that overrides the local servers config file location. */
export const LOCAL_SERVERS_FILE_ENV = 'CALL_MCP_SERVERS_FILE';

/** The local servers config file exists but cannot be parsed or is invalid. */
export class LocalConfigError extends Error {}

export type LocalServerConfig = {
	type: 'http' | 'stdio';
	/** http: the server URL (MCP Streamable HTTP). */
	url?: string;
	/** http: extra request headers, e.g. an Authorization header. */
	headers?: Record<string, string>;
	/** stdio: the executable to spawn. */
	command?: string;
	/** stdio: arguments for the executable. */
	args?: string[];
	/** stdio: extra environment variables for the spawned process. */
	env?: Record<string, string>;
};

export type LocalServer = {
	/** Stable identifier: `local:<name>`. */
	id: string;
	display_name: string;
	/** The URL for http servers, or the command line for stdio servers. */
	url: string;
	source: 'local';
	configPath: string;
	/** The raw (unexpanded) config block — ${VAR} expansion happens at connect time. */
	config: LocalServerConfig;
};

/** Candidate config file locations; the first existing file wins. */
export function localConfigPaths(): string[] {
	const paths: string[] = [];
	const fromEnv = process.env[LOCAL_SERVERS_FILE_ENV]?.trim();
	if (fromEnv) {
		paths.push(fromEnv);
	}

	const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
	paths.push(join(configHome, 'call-mcp', 'servers.json'));
	return paths;
}

/** Loads servers from the local config file, or returns [] if no config file exists. */
export async function loadLocalServers(): Promise<LocalServer[]> {
	for (const path of localConfigPaths()) {
		let raw: string;
		try {
			// eslint-disable-next-line no-await-in-loop
			raw = await readFile(path, 'utf8');
		} catch {
			continue; // No file at this location — try the next candidate.
		}

		return parseLocalServers(raw, path);
	}

	return [];
}

/** Parses and validates a servers config file. Exported for testing. */
export function parseLocalServers(raw: string, path: string): LocalServer[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new LocalConfigError(`Could not parse local MCP server config ${path}: ${(err as Error).message}`);
	}

	const block = (parsed as {mcpServers?: unknown})?.mcpServers;
	if (typeof block !== 'object' || block === null || Array.isArray(block)) {
		throw new LocalConfigError(`${path} must contain an "mcpServers" object (the same shape as Claude Code's MCP config).`);
	}

	return Object.entries(block as Record<string, unknown>).map(([name, config]) => parseServer(name, config, path));
}

function parseServer(name: string, raw: unknown, path: string): LocalServer {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new LocalConfigError(`Server "${name}" in ${path} must be an object.`);
	}

	const record = raw as Record<string, unknown>;
	const type = record.type ?? (record.url ? 'http' : 'stdio');

	if (type === 'sse') {
		throw new LocalConfigError(`Server "${name}" in ${path} uses the legacy "sse" transport, which call-mcp does not support. Use an MCP Streamable HTTP server (type "http") or a stdio server instead.`);
	}

	if (type !== 'http' && type !== 'stdio') {
		throw new LocalConfigError(`Server "${name}" in ${path} has unsupported type ${JSON.stringify(type)} (supported: "http", "stdio").`);
	}

	if (type === 'http' && typeof record.url !== 'string') {
		throw new LocalConfigError(`Server "${name}" in ${path} is missing "url".`);
	}

	if (type === 'stdio' && typeof record.command !== 'string') {
		throw new LocalConfigError(`Server "${name}" in ${path} is missing "command".`);
	}

	const config = {...record, type} as LocalServerConfig;
	const commandSummary = [config.command, ...(config.args ?? [])].filter(Boolean).join(' ');

	return {
		id: `local:${name}`,
		display_name: name,
		url: config.url ?? commandSummary,
		source: 'local',
		configPath: path,
		config,
	};
}

/**
 * Expands ${VAR} placeholders from the environment in strings, recursively
 * through arrays and objects. Unknown variables are left as-is so
 * misconfigurations stay visible rather than silently becoming empty strings.
 * Exported for testing.
 */
export function expandEnv<T>(value: T): T {
	if (typeof value === 'string') {
		return value.replace(/\$\{([A-Za-z_][A-Za-z\d_]*)\}/g, (whole, name: string) => process.env[name] ?? whole) as T;
	}

	if (Array.isArray(value)) {
		return value.map((v) => expandEnv(v)) as T;
	}

	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)])) as T;
	}

	return value;
}

/**
 * Opens an initialized MCP session to a server from the local config.
 *
 * http servers use the MCP Streamable HTTP transport with any configured
 * headers; stdio servers are spawned as a child process for the duration of
 * this invocation (the SDK's default minimal environment plus any configured
 * env vars).
 */
export async function connectLocal(server: LocalServer): Promise<Client> {
	const config = expandEnv(server.config);
	// The cast is needed because the SDK's own client transports don't satisfy its
	// Transport interface under exactOptionalPropertyTypes (sessionId is typed
	// `string | undefined` rather than optional).
	const transport = (config.type === 'http'
		? new StreamableHTTPClientTransport(
			new URL(config.url!),
			config.headers ? {requestInit: {headers: config.headers}} : {},
		)
		: new StdioClientTransport({
			command: config.command!,
			args: config.args ?? [],
			env: {...getDefaultEnvironment(), ...config.env},
		})) as Transport;

	const client = new Client(
		{name: 'call-mcp', version: '0.1.0'},
		{capabilities: {}},
	);

	try {
		await client.connect(transport);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const authHint = /\b(401|403|unauthorized|forbidden)\b/i.test(message)
			? ' The server may require authentication: add a "headers" block with an Authorization header in the servers config (OAuth flows are not supported yet), or keep it as a claude.ai connector.'
			: '';
		throw new Error(`Could not connect to local server '${server.display_name}': ${message}.${authHint}`);
	}

	return client;
}
