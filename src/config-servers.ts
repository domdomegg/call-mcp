import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {UnauthorizedError} from '@modelcontextprotocol/sdk/client/auth.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {getDefaultEnvironment, StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {z} from 'zod';
import {FileOAuthClientProvider, oauthCacheDir} from './oauth.js';

/** Environment variable that overrides the servers config file location. */
export const SERVERS_CONFIG_FILE_ENV = 'CALL_MCP_SERVERS_FILE';

/** The servers config file exists but cannot be parsed or is invalid. */
export class ServersConfigError extends Error {}

/**
 * One server entry in the config file. The transport-specific rules (http needs
 * a url, stdio needs a command, the legacy sse transport is rejected) are
 * enforced here too, with messages phrased to follow `Server "<name>" in <path> …`.
 */
const serverConfigSchema = z
	.object({
		type: z.string().optional(),
		// http
		url: z.string().optional(),
		headers: z.record(z.string(), z.string()).optional(),
		oauth: z
			.object({
				client_id: z.string().optional(),
				client_secret: z.string().optional(),
				scope: z.string().optional(),
			})
			.optional(),
		// stdio
		command: z.string().optional(),
		args: z.array(z.string()).optional(),
		env: z.record(z.string(), z.string()).optional(),
	})
	.superRefine((config, ctx) => {
		if (config.type === 'sse') {
			ctx.addIssue({code: 'custom', message: 'uses the legacy "sse" transport, which call-mcp does not support. Use an MCP Streamable HTTP server (type "http") or a stdio server instead.'});
			return;
		}

		const type = config.type ?? (config.url ? 'http' : 'stdio');
		if (type !== 'http' && type !== 'stdio') {
			ctx.addIssue({code: 'custom', message: `has unsupported type ${JSON.stringify(config.type)} (supported: "http", "stdio").`});
			return;
		}

		if (type === 'http' && !config.url) {
			ctx.addIssue({code: 'custom', message: 'is missing "url".'});
		}

		if (type === 'stdio' && !config.command) {
			ctx.addIssue({code: 'custom', message: 'is missing "command".'});
		}
	});

const serversFileSchema = z.object({
	mcpServers: z.record(z.string(), serverConfigSchema),
});

/** A server's config block, with `type` resolved to a concrete transport. */
export type ServerConfig = z.infer<typeof serverConfigSchema> & {type: 'http' | 'stdio'};

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
	const fromEnv = process.env[SERVERS_CONFIG_FILE_ENV]?.trim();
	if (fromEnv) {
		// An explicit override is authoritative — no falling back to the default
		// location (this also lets tests and scripts isolate themselves from a
		// user's real config).
		return [fromEnv];
	}

	const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
	return [join(configHome, 'call-mcp', 'servers.json')];
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

	const result = serversFileSchema.safeParse(parsed);
	if (!result.success) {
		throw new ServersConfigError(formatConfigIssue(result.error, path));
	}

	return Object.entries(result.data.mcpServers).map(([name, config]): ConfiguredServer => {
		// Validated by the schema above, so the inferred fallback is always concrete.
		const type = (config.type ?? (config.url ? 'http' : 'stdio')) as ServerConfig['type'];
		const commandSummary = [config.command, ...(config.args ?? [])].filter(Boolean).join(' ');

		return {
			id: name,
			display_name: name,
			url: config.url ?? commandSummary,
			source: 'config',
			configPath: path,
			config: {...config, type},
		};
	});
}

/** Turns the first schema issue into a single friendly error message. */
function formatConfigIssue(error: z.ZodError, path: string): string {
	const issue = error.issues[0]!;
	const [, serverName, ...fieldPath] = issue.path;
	if (serverName === undefined) {
		return `${path} must contain an "mcpServers" object (the same shape as Claude Code's MCP config).`;
	}

	const field = fieldPath.length > 0 ? ` ${fieldPath.map(String).join('.')}:` : '';
	return `Server "${String(serverName)}" in ${path}${field} ${issue.message}`;
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
