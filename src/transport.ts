import {randomUUID} from 'node:crypto';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';

const MCP_PROXY_URL = 'https://mcp-proxy.anthropic.com';
const MCP_PROXY_PATH = '/v1/mcp/{server_id}';

/** Where a user re-authorizes a claude.ai connector (the connectors settings page). */
export const CONNECTORS_SETTINGS_URL = 'https://claude.ai/customize/connectors';

/**
 * Thrown when the proxy reports that the upstream connector itself needs
 * authorization (the `mcp_unauthorized*` error codes). The CC token authed us
 * to the proxy fine, but the proxy has no usable OAuth token for the upstream
 * server — the user must (re-)connect it in claude.ai settings.
 */
export class ConnectorAuthError extends Error {
	readonly authUrl: string;
	constructor(message: string, authUrl = CONNECTORS_SETTINGS_URL) {
		super(message);
		this.name = 'ConnectorAuthError';
		this.authUrl = authUrl;
	}
}

/**
 * MCP Streamable HTTP transport for the claude.ai MCP proxy
 * (mcp-proxy.anthropic.com).
 *
 * Differs from the SDK's stock StreamableHTTPClientTransport in one way: the
 * proxy does not issue an `mcp-session-id` response header. Instead the client
 * generates a session id up front and sends it as `X-Mcp-Client-Session-Id` on
 * every request. Each POST returns the response inline (as an SSE
 * `event: message` frame or plain JSON); there is no long-lived stream to hold
 * open, so this transport just POSTs and parses.
 */
export class ProxyTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;
	sessionId: string;

	private readonly endpoint: string;
	private readonly accessToken: string;
	private closed = false;

	constructor(serverId: string, accessToken: string) {
		this.endpoint = MCP_PROXY_URL + MCP_PROXY_PATH.replace('{server_id}', serverId);
		this.accessToken = accessToken;
		this.sessionId = randomUUID();
	}

	async start(): Promise<void> {
		// No connection to open — requests are independent POSTs.
	}

	async close(): Promise<void> {
		this.closed = true;
		this.onclose?.();
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (this.closed) {
			throw new Error('Transport is closed');
		}

		let res: Response;
		try {
			res = await fetch(this.endpoint, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.accessToken}`,
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
					'X-Mcp-Client-Session-Id': this.sessionId,
				},
				body: JSON.stringify(message),
			});
		} catch (err) {
			this.onerror?.(err as Error);
			throw err;
		}

		// Notifications (no `id`) get an empty 202 — nothing to deliver back.
		const isRequest = 'id' in message && 'method' in message;

		const raw = await res.text();
		if (!res.ok) {
			const err = this.describeError(res.status, raw);
			this.onerror?.(err);
			throw err;
		}

		if (!isRequest || raw.trim() === '') {
			return;
		}

		for (const parsed of parseBody(raw)) {
			this.onmessage?.(parsed);
		}
	}

	private describeError(status: number, raw: string): Error {
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			return new Error(`proxy returned HTTP ${status}: ${raw.slice(0, 200)}`);
		}

		const error = (body as {error?: {message?: string; details?: {error_code?: string}}})
			?.error;
		const code = error?.details?.error_code;
		const msg = error?.message ?? raw;

		// The proxy does not return a WWW-Authenticate header or an auth URL in the
		// body, so we point the user at the claude.ai connectors page (the same URL
		// Claude Code itself uses for connector setup).
		if (typeof code === 'string' && code.startsWith('mcp_unauthorized')) {
			return new ConnectorAuthError(msg);
		}

		return new Error(`proxy returned HTTP ${status}: ${msg}`);
	}
}

/**
 * Parses a proxy response body, which is either a plain JSON-RPC object or an
 * SSE stream of `event: message` frames. Yields each JSON-RPC message found.
 *
 * Exported for testing.
 */
export function * parseBody(raw: string): Generator<JSONRPCMessage> {
	const trimmed = raw.trim();
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		yield JSON.parse(trimmed) as JSONRPCMessage;
		return;
	}

	for (const block of trimmed.split(/\n\n+/)) {
		const dataLines = block
			.split('\n')
			.filter((l) => l.startsWith('data:'))
			.map((l) => l.slice(5).trim());
		if (dataLines.length === 0) {
			continue;
		}

		yield JSON.parse(dataLines.join('\n')) as JSONRPCMessage;
	}
}
