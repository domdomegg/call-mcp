import type {Token} from './auth.js';

// TEST_ONLY_API_URL_OVERRIDE points the discovery API at a mock server in the
// e2e tests. It is not a supported configuration knob and is intentionally
// undocumented — do not rely on it.
const BASE_API_URL = process.env.TEST_ONLY_API_URL_OVERRIDE ?? 'https://api.anthropic.com';
const MCP_SERVERS_BETA = 'mcp-servers-2025-12-04';

export type McpServer = {
	id: string;
	display_name: string;
	url: string;
	created_at: string;
};

export class DiscoveryError extends Error {}

type McpServersResponse = {
	data?: McpServer[];
	error?: {message?: string};
};

/** Lists the claude.ai-configured MCP servers ("org connectors") for the account. */
export async function listServers(token: Token): Promise<McpServer[]> {
	const res = await fetch(`${BASE_API_URL}/v1/mcp_servers?limit=1000`, {
		headers: {
			Authorization: `Bearer ${token.accessToken}`,
			'anthropic-beta': MCP_SERVERS_BETA,
			'anthropic-version': '2023-06-01',
		},
	});

	const body = (await res.json().catch(() => null)) as McpServersResponse | null;
	if (!res.ok) {
		const msg = body?.error?.message ?? `HTTP ${res.status}`;
		throw new DiscoveryError(`Failed to list MCP servers: ${msg}`);
	}

	return body?.data ?? [];
}

/**
 * Resolves a user-supplied server reference to a server.
 * Accepts an exact id (`mcpsrv_...`), an exact display name, or a unique
 * case-insensitive display-name prefix.
 */
export function resolveServer(servers: McpServer[], ref: string): McpServer {
	const byId = servers.find((s) => s.id === ref);
	if (byId) {
		return byId;
	}

	const exactName = uniqueMatch(servers, (s) => s.display_name === ref);
	if (exactName) {
		return exactName;
	}

	const lower = ref.toLowerCase();
	const exactNameCi = uniqueMatch(servers, (s) => s.display_name.toLowerCase() === lower);
	if (exactNameCi) {
		return exactNameCi;
	}

	const prefix = servers.filter((s) => s.display_name.toLowerCase().startsWith(lower));
	if (prefix.length === 1) {
		return prefix[0]!;
	}

	if (prefix.length > 1) {
		throw new DiscoveryError(`Server reference "${ref}" is ambiguous; matches: ${prefix
			.map((s) => s.display_name)
			.join(', ')}`);
	}

	throw new DiscoveryError(`No MCP server matches "${ref}". Run \`mcpc list\` to see available servers.`);
}

/** Returns the single server matching `predicate`, or undefined if zero or many match. */
function uniqueMatch(
	servers: McpServer[],
	predicate: (s: McpServer) => boolean,
): McpServer | undefined {
	const matches = servers.filter(predicate);
	return matches.length === 1 ? matches[0] : undefined;
}
