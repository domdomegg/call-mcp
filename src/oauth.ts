import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer, type Server} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import type {AddressInfo} from 'node:net';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
	OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/** How long to wait for the user to approve the authorization in their browser. */
const AUTHORIZATION_TIMEOUT_MS = 180_000;

/** Optional per-server OAuth settings from the servers config. */
export type OAuthConfig = {
	/** Static client credentials, for servers that don't support dynamic client registration. */
	client_id?: string | undefined;
	client_secret?: string | undefined;
	/** Scope to request during authorization. */
	scope?: string | undefined;
};

type StoredAuth = {
	serverUrl: string;
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
};

/** Directory where cached OAuth state (tokens, client registration) lives, one file per server. */
export function oauthCacheDir(): string {
	const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
	return join(configHome, 'call-mcp', 'auth');
}

function cacheFileName(serverName: string): string {
	return `${serverName.replaceAll(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}

/**
 * An OAuthClientProvider for the SDK's HTTP transports that caches tokens and
 * client registrations on disk (one JSON file per server, mode 0600), opens the
 * system browser for the authorization step, and receives the redirect on a
 * loopback HTTP listener.
 */
export class FileOAuthClientProvider implements OAuthClientProvider {
	/**
	 * Creates a provider for a server, loading any cached state from disk and
	 * starting the loopback callback listener (unref'd, so it never keeps the
	 * process alive).
	 */
	static async create(serverName: string, serverUrl: string, oauth?: OAuthConfig): Promise<FileOAuthClientProvider> {
		const filePath = join(oauthCacheDir(), cacheFileName(serverName));
		let stored: StoredAuth = {serverUrl};
		try {
			const parsed = JSON.parse(await readFile(filePath, 'utf8')) as StoredAuth;
			// A changed URL means the cached tokens belong to a different server.
			if (parsed.serverUrl === serverUrl) {
				stored = parsed;
			}
		} catch {
			// No cache yet — first authorization for this server.
		}

		const provider = new FileOAuthClientProvider(serverName, serverUrl, filePath, stored, oauth);
		await provider.startCallbackListener();
		return provider;
	}

	private readonly oauthState = randomUUID();
	private callbackPort = 0;
	private callbackServer: Server | undefined;
	private authorizationCode = new Promise<string>(() => {/* replaced by startCallbackListener */});

	private constructor(
		private readonly serverName: string,
		private readonly serverUrl: string,
		private readonly filePath: string,
		private readonly stored: StoredAuth,
		private readonly oauth?: OAuthConfig,
	) {}

	get redirectUrl(): string {
		return `http://127.0.0.1:${this.callbackPort}/callback`;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: 'call-mcp',
			redirect_uris: [this.redirectUrl],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: this.oauth?.client_secret ? 'client_secret_post' : 'none',
			...(this.oauth?.scope ? {scope: this.oauth.scope} : {}),
		};
	}

	state(): string {
		return this.oauthState;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		if (this.oauth?.client_id) {
			return {
				client_id: this.oauth.client_id,
				...(this.oauth.client_secret ? {client_secret: this.oauth.client_secret} : {}),
			};
		}

		return this.stored.clientInformation;
	}

	async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
		this.stored.clientInformation = clientInformation;
		await this.persist();
	}

	tokens(): OAuthTokens | undefined {
		return this.stored.tokens;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		this.stored.tokens = tokens;
		await this.persist();
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		this.stored.codeVerifier = codeVerifier;
		await this.persist();
	}

	codeVerifier(): string {
		if (!this.stored.codeVerifier) {
			throw new Error(`No PKCE code verifier saved for server '${this.serverName}' — restart the authorization flow.`);
		}

		return this.stored.codeVerifier;
	}

	async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
		if (scope === 'all' || scope === 'client') {
			delete this.stored.clientInformation;
		}

		if (scope === 'all' || scope === 'tokens') {
			delete this.stored.tokens;
		}

		if (scope === 'all' || scope === 'verifier') {
			delete this.stored.codeVerifier;
		}

		await this.persist();
	}

	/** Opens the user's browser at the authorization URL (and prints it as a fallback). */
	redirectToAuthorization(authorizationUrl: URL): void {
		process.stderr.write(`Authorization required for '${this.serverName}'.\n`
			+ `Opening your browser — if nothing happens, open this URL yourself:\n  ${authorizationUrl.toString()}\n`);

		// The URL comes from server-controlled metadata, so treat it as untrusted:
		// only hand http(s) URLs to the OS opener, pass it as an argument (never
		// through a shell), and otherwise rely on the printed URL above.
		if (authorizationUrl.protocol !== 'https:' && authorizationUrl.protocol !== 'http:') {
			return;
		}

		const target = authorizationUrl.toString();
		let command: string;
		let args: string[];
		if (process.platform === 'darwin') {
			command = 'open';
			args = [target];
		} else if (process.platform === 'win32') {
			command = 'rundll32';
			args = ['url.dll,FileProtocolHandler', target];
		} else {
			command = 'xdg-open';
			args = [target];
		}

		try {
			const child = spawn(command, args, {stdio: 'ignore', detached: true});
			child.unref();
			child.on('error', () => {/* The URL is already printed; nothing else to do. */});
		} catch {
			// The URL is already printed; nothing else to do.
		}
	}

	/** Resolves with the authorization code once the browser redirect lands on the loopback listener. */
	async waitForAuthorizationCode(): Promise<string> {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				this.authorizationCode,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						reject(new Error(`Timed out after ${AUTHORIZATION_TIMEOUT_MS / 1000}s waiting for authorization of '${this.serverName}' in the browser.`));
					}, AUTHORIZATION_TIMEOUT_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
			this.callbackServer?.close();
		}
	}

	private async startCallbackListener(): Promise<void> {
		this.authorizationCode = new Promise<string>((resolve, reject) => {
			this.callbackServer = createServer((req, res) => {
				const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.callbackPort}`);
				if (url.pathname !== '/callback') {
					res.writeHead(404).end();
					return;
				}

				const code = url.searchParams.get('code');
				const state = url.searchParams.get('state');
				const error = url.searchParams.get('error');

				if (error || !code) {
					res.writeHead(400, {'content-type': 'text/html; charset=utf-8'});
					res.end('<!doctype html><meta charset="utf-8"><body>Authorization failed — you can close this tab and check the terminal.</body>');
					reject(new Error(`Authorization for '${this.serverName}' failed: ${error ?? 'no code returned'}`));
					return;
				}

				if (state !== this.oauthState) {
					res.writeHead(400, {'content-type': 'text/html; charset=utf-8'});
					res.end('<!doctype html><meta charset="utf-8"><body>Authorization failed (state mismatch) — you can close this tab.</body>');
					reject(new Error(`Authorization for '${this.serverName}' failed: state mismatch.`));
					return;
				}

				res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
				res.end('<!doctype html><meta charset="utf-8"><body>Authorized — you can close this tab and return to the terminal.</body>');
				resolve(code);
			});
		});

		// A request can hit the callback before (or without) waitForAuthorizationCode
		// being awaited — e.g. something else probing the loopback port. That must
		// never become an unhandled rejection; the real consumer still receives the
		// rejection through waitForAuthorizationCode().
		void this.authorizationCode.catch(() => {/* Surfaced via waitForAuthorizationCode. */});

		await new Promise<void>((resolve) => {
			this.callbackServer!.listen(0, '127.0.0.1', resolve);
		});
		this.callbackPort = (this.callbackServer!.address() as AddressInfo).port;
		// Never keep the CLI process alive just because the listener is open.
		this.callbackServer!.unref();
	}

	private async persist(): Promise<void> {
		await mkdir(oauthCacheDir(), {recursive: true, mode: 0o700});
		await writeFile(this.filePath, `${JSON.stringify(this.stored, null, '\t')}\n`, {mode: 0o600});
	}
}
