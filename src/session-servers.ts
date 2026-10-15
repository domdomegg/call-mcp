import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseConfiguredServers, ServersConfigError, type ConfiguredServer} from './config-servers.js';

/** Environment variable that points at a specific session MCP config file (overrides detection). */
export const SESSION_CONFIG_FILE_ENV = 'CALL_MCP_SESSION_CONFIG';

/**
 * Where a Claude Code cloud session's launcher keeps the session ingress token,
 * used when CLAUDE_SESSION_INGRESS_TOKEN_FILE isn't set (Claude Code falls back
 * to the same path). This is the launcher's directory, not the Claude Code
 * config dir, so it deliberately ignores CLAUDE_CONFIG_DIR.
 */
const DEFAULT_INGRESS_TOKEN_FILE = '/home/claude/.claude/remote/.session_ingress_token';

/**
 * The MCP config file the current Claude Code cloud session was launched with,
 * or undefined when not running inside one. The launcher writes it to
 * /tmp/mcp-config-<session id>.json, and the session id is exported to every
 * process in the session as CLAUDE_CODE_REMOTE_SESSION_ID.
 */
export function sessionConfigPath(): string | undefined {
	const fromEnv = process.env[SESSION_CONFIG_FILE_ENV]?.trim();
	if (fromEnv) {
		return fromEnv;
	}

	const sessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID?.trim();
	// Guard against path tricks: session ids are plain `cse_...` style tokens.
	if (!sessionId || !/^[\w-]+$/.test(sessionId)) {
		return undefined;
	}

	return join('/tmp', `mcp-config-${sessionId}.json`);
}

/** The file holding the session ingress token, which the session's MCP routes accept as a bearer token. */
export function sessionTokenPath(): string {
	return process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE?.trim() || DEFAULT_INGRESS_TOKEN_FILE;
}

/**
 * Loads the MCP servers of the Claude Code cloud session call-mcp is running
 * in, or returns [] when not in a session.
 *
 * The session's config file already uses the "mcpServers" shape (http servers
 * pointing at a per-session Anthropic route), minus the Authorization header —
 * the session ingress token is read from its file at connect time, so it is
 * never held on the server object or printed by `list --full`.
 */
export async function loadSessionServers(): Promise<ConfiguredServer[]> {
	const path = sessionConfigPath();
	if (!path) {
		return [];
	}

	let raw: string;
	try {
		raw = await readFile(path, 'utf8');
	} catch (err) {
		if (process.env[SESSION_CONFIG_FILE_ENV]?.trim()) {
			throw new ServersConfigError(`Could not read the session MCP config ${path} (from ${SESSION_CONFIG_FILE_ENV}): ${(err as Error).message}`);
		}

		return []; // Session id is set but there's no config file — nothing to add.
	}

	const tokenFile = sessionTokenPath();
	return parseConfiguredServers(raw, path).map((server) => ({
		...server,
		source: 'session',
		...(server.config.type === 'http' ? {tokenFile} : {}),
	}));
}
