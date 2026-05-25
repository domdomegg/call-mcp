import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {UnauthorizedError} from '@modelcontextprotocol/sdk/client/auth.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {getDefaultEnvironment, StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {FileOAuthClientProvider, oauthCacheDir, type OAuthConfig} from './oauth.js';

/** Environment variable that overrides the servers config file location. */
export const SERVERS_CONFIG_FILE_ENV = 'CALL_MCP_SERVERS_FILE';

/** The servers config file exists but cannot be parsed or is invalid. */
export class ServersConfigError extends Error {}

export type ServerConfig = {
	type: 'http' | 'stdio';
	/** http: the server URL (MCP Streamable HTTP). */
	url?: string;
	/** http: extra request headers, e.g. an Authorization header. */
	headers?: Record<string, string>;
	/** http: optional OAuth settings (static client credentials, scope) for servers that need them. */
	oauth?: OAuthConfig;
	/** stdio: the executable to spawn. */
	command?: string;
	/** stdio: arguments for the executable. */
	args?: string[];
	/** stdio: extra environment variables for the spawned process. */
	env?: Record<string, string>;
};

export type ConfiguredServer = {
	/** The server's name in the config file (also used as its id). */
	id: string;
	display_name: string;
	/** The URL for http servers, or the command line for stdio servers. */
	url: string;
	source: 'config';
	configPath: string;
	/** The raw (unexpanded) config block — ${VAR} expansion happens at connect time. */
	config: ServerConfig;
};

/** Candidate config file locations; the first existing file wins. */
export function serversConfigPaths(): string[] {
	const paths: string[] = [];
	const fromEnv = process.env[SERVERS_CONFIG_FILE_ENV]?.trim();
	if (fromEnv) {
		paths.push(fromEnv);
	}

	const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
	paths.push(join(configHome, 'call-mcp', 'servers.json'));
	return paths;
}

/** Loads servers from the servers config file, or returns [] if no config file exists. */
export async function loadConfiguredServers(): Promise<ConfiguredServer[]> {
	for (const path of serversConfigPaths()) {
		let raw: string;
		try {
			// eslint-disable-next-line no-await-in-loop
			raw = await readFile(path, 'utf8');
		} catch {
			continue; // No file at this location — try the next candidate.
		}

		return parseConfiguredServers(raw, path);
	}

	return [];
}

/** Parses and validates a servers config file. Exported for testing. */
export function parseConfiguredServers(raw: string, path: string): ConfiguredServer[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ServersConfigError(`Could not parse the servers config ${path}: ${(err as Error).message}`);
	}

	const block = (parsed as {mcpServers?: unknown})?.mcpServers;
	if (typeof block !== 'object' || block === null || Array.isArray(block)) {
		throw new ServersConfigError(`${path} must contain an "mcpServers" object (the same shape as Claude Code's MCP config).`);
	}

	return Object.entries(block as Record<string, unknown>).map(([name, config]) => parseServer(name, config, path));
}

function parseServer(name: string, raw: unknown, path: string): ConfiguredServer {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new ServersConfigError(`Server "${name}" in ${path} must be an object.`);
	}

	const record = raw as Record<string, unknown>;
	const type = record.type ?? (record.url ? 'http' : 'stdio');

	if (type === 'sse') {
		throw new ServersConfigError(`Server "${name}" in ${path} uses the legacy "sse" transport, which call-mcp does not support. Use an MCP Streamable HTTP server (type "http") or a stdio server instead.`);
	}

	if (type !== 'http' && type !== 'stdio') {
		throw new ServersConfigError(`Server "${name}" in ${path} has unsupported type ${JSON.stringify(type)} (supported: "http", "stdio").`);
	}

	if (type === 'http' && typeof record.url !== 'string') {
		throw new ServersConfigError(`Server "${name}" in ${path} is missing "url".`);
	}

	if (type === 'stdio' && typeof record.command !== 'string') {
		throw new ServersConfigError(`Server "${name}" in ${path} is missing "command".`);
	}

	const config = {...record, type} as ServerConfig;
	const commandSummary = [config.command, ...(config.args ?? [])].filter(Boolean).join(' ');

	return {
		id: name,
		display_name: name,
		url: config.url ?? commandSummary,
		source: 'config',
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
 * Opens an initialized MCP session to a server from the servers config.
 *
 * http servers use the MCP Streamable HTTP transport with any configured
 * headers; if a server demands OAuth (401), the browser-based authorization
 * flow runs and tokens are cached for next time. stdio servers are spawned as
 * a child process for the duration of this invocation (the SDK's default
 * minimal environment plus any configured env vars).
 */
export async function connectConfiguredServer(server: ConfiguredServer): Promise<Client> {
	const config = expandEnv(server.config);

	try {
		return config.type === 'http'
			? await connectHttp(server, config)
			: await connectStdio(config);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const authHint = /\b(401|403|unauthorized|forbidden)\b/i.test(message)
			? ` If the server uses OAuth, retry and approve the authorization in your browser (cached under ${oauthCacheDir()}); for static credentials, add an Authorization header under "headers" in the servers config.`
			: '';
		throw new Error(`Could not connect to server '${server.display_name}': ${message}.${authHint}`);
	}
}

function newClient(): Client {
	return new Client(
		{name: 'call-mcp', version: '0.1.0'},
		{capabilities: {}},
	);
}

async function connectStdio(config: ServerConfig): Promise<Client> {
	// The cast is needed because the SDK's own client transports don't satisfy its
	// Transport interface under exactOptionalPropertyTypes (sessionId is typed
	// `string | undefined` rather than optional).
	const transport = new StdioClientTransport({
		command: config.command!,
		args: config.args ?? [],
		env: {...getDefaultEnvironment(), ...config.env},
	}) as Transport;

	const client = newClient();
	await client.connect(transport);
	return client;
}

async function connectHttp(server: ConfiguredServer, config: ServerConfig): Promise<Client> {
	// A configured Authorization header takes precedence; otherwise the MCP OAuth
	// flow is available should the server demand it.
	const hasAuthHeader = Object.keys(config.headers ?? {}).some((h) => h.toLowerCase() === 'authorization');
	const authProvider = hasAuthHeader
		? undefined
		: await FileOAuthClientProvider.create(server.display_name, config.url!, config.oauth);

	const makeTransport = () => new StreamableHTTPClientTransport(new URL(config.url!), {
		...(config.headers ? {requestInit: {headers: config.headers}} : {}),
		...(authProvider ? {authProvider} : {}),
	});

	const transport = makeTransport();
	const client = newClient();
	try {
		await client.connect(transport as Transport);
		return client;
	} catch (err) {
		if (!authProvider || !(err instanceof UnauthorizedError)) {
			throw err;
		}
	}

	// The server demanded authorization and the provider has opened the browser.
	// Wait for the redirect to land, finish the code exchange, then connect afresh.
	const code = await authProvider.waitForAuthorizationCode();
	await transport.finishAuth(code);
	const retryClient = newClient();
	await retryClient.connect(makeTransport() as Transport);
	return retryClient;
}
