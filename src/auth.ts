import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CREDENTIALS_FILE = '.credentials.json';

type ClaudeAiOauth = {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	scopes: string[];
	subscriptionType?: string;
};

export type Token = {
	accessToken: string;
	expiresAt?: number;
	scopes?: string[];
	/** Where the token came from — used to tailor the "how to refresh" hint. */
	source: 'env' | 'keychain' | 'file';
};

export class AuthError extends Error {}

/**
 * Resolves the Claude Code OAuth token, mirroring how Claude Code itself stores
 * credentials:
 *
 *   1. CLAUDE_CODE_OAUTH_TOKEN env var (all platforms) — used verbatim.
 *   2. macOS: the login Keychain (service "Claude Code-credentials"), then the
 *      plaintext credentials file as a fallback.
 *   3. Linux / Windows: the plaintext credentials file at
 *      <config-dir>/.credentials.json.
 *
 * The config dir is CLAUDE_CONFIG_DIR if set, otherwise ~/.claude.
 *
 * mcpc never writes credentials back. On expiry it tells the user to refresh
 * via Claude Code rather than running the OAuth refresh flow itself.
 */
export async function getToken(): Promise<Token> {
	const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
	if (envToken) {
		return {accessToken: envToken, source: 'env'};
	}

	const oauth = await readStoredOauth();
	if (!oauth?.accessToken) {
		throw notFoundError();
	}

	if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
		const ago = Math.round((Date.now() - oauth.expiresAt) / 60000);
		throw new AuthError(`The Claude Code token expired ${ago} minute(s) ago.\n`
			+ 'Run `claude` once to refresh it, then retry.');
	}

	if (oauth.scopes && !oauth.scopes.includes('user:mcp_servers')) {
		throw new AuthError('The Claude Code token is missing the `user:mcp_servers` scope, so it cannot list claude.ai MCP servers.\n'
			+ 'Re-login with `claude` to obtain an updated token.');
	}

	return {
		accessToken: oauth.accessToken,
		expiresAt: oauth.expiresAt,
		scopes: oauth.scopes,
		source: macKeychainAvailable() ? 'keychain' : 'file',
	};
}

/** Reads the stored OAuth blob from the Keychain (macOS) or the credentials file. */
async function readStoredOauth(): Promise<ClaudeAiOauth | null> {
	if (process.platform === 'darwin') {
		const fromKeychain = await readKeychain();
		if (fromKeychain) {
			return fromKeychain;
		}
	}

	return readCredentialsFile();
}

async function readKeychain(): Promise<ClaudeAiOauth | null> {
	try {
		const {stdout} = await execFileAsync('security', [
			'find-generic-password',
			'-s',
			KEYCHAIN_SERVICE,
			'-w',
		]);
		return parseOauthBlob(stdout.trim());
	} catch {
		return null;
	}
}

async function readCredentialsFile(): Promise<ClaudeAiOauth | null> {
	try {
		const raw = await readFile(credentialsFilePath(), 'utf8');
		return parseOauthBlob(raw);
	} catch {
		return null;
	}
}

function parseOauthBlob(raw: string): ClaudeAiOauth | null {
	try {
		const oauth = JSON.parse(raw)?.claudeAiOauth;
		return oauth?.accessToken ? (oauth as ClaudeAiOauth) : null;
	} catch {
		return null;
	}
}

function configDir(): string {
	return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

function credentialsFilePath(): string {
	return join(configDir(), CREDENTIALS_FILE);
}

function macKeychainAvailable(): boolean {
	return process.platform === 'darwin';
}

function notFoundError(): AuthError {
	const where = process.platform === 'darwin'
		? `the macOS Keychain (service "${KEYCHAIN_SERVICE}") or ${credentialsFilePath()}`
		: credentialsFilePath();
	return new AuthError(`Could not find Claude Code credentials in ${where}.\n`
		+ 'Log in with `claude` first, or set CLAUDE_CODE_OAUTH_TOKEN to a token with the `user:mcp_servers` scope.');
}
