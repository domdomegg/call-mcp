import {
	test, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// The macOS Keychain is an external system: on a developer's Mac it may hold a
// real Claude Code token, which would mask the file-based fixtures below. Stub
// the child_process call `auth.ts` uses to read it so every test starts from a
// known-empty Keychain and only the file / env paths are exercised.
vi.mock('node:child_process', () => ({
	execFile(
		_cmd: string,
		_args: string[],
		cb: (err: Error | null, out: {stdout: string; stderr: string}) => void,
	) {
		cb(new Error('keychain item not found'), {stdout: '', stderr: ''});
	},
}));

const {getToken, AuthError} = await import('./auth.js');

const SCOPES = ['user:inference', 'user:mcp_servers', 'user:profile'];

function credentialsBlob(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		claudeAiOauth: {
			accessToken: 'sk-ant-oat01-fixture',
			refreshToken: 'sk-ant-ort01-fixture',
			expiresAt: Date.now() + 3_600_000,
			scopes: SCOPES,
			...overrides,
		},
	});
}

let tmpDir: string;
const savedEnv = {
	CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
	CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'call-mcp-auth-'));
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	process.env.CLAUDE_CONFIG_DIR = tmpDir;
});

afterEach(() => {
	rmSync(tmpDir, {recursive: true, force: true});
	// Restore both vars to their original values (or unset if unset before).
	if (savedEnv.CLAUDE_CODE_OAUTH_TOKEN === undefined) {
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	} else {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = savedEnv.CLAUDE_CODE_OAUTH_TOKEN;
	}

	if (savedEnv.CLAUDE_CONFIG_DIR === undefined) {
		delete process.env.CLAUDE_CONFIG_DIR;
	} else {
		process.env.CLAUDE_CONFIG_DIR = savedEnv.CLAUDE_CONFIG_DIR;
	}
});

function writeCredentials(blob: string): void {
	writeFileSync(join(tmpDir, '.credentials.json'), blob);
}

test('uses CLAUDE_CODE_OAUTH_TOKEN when set, marking the source as env', async () => {
	process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-from-env';
	const token = await getToken();
	expect(token).toEqual({accessToken: 'sk-ant-oat01-from-env', source: 'env'});
});

test('reads the credentials file when no env var is set', async () => {
	writeCredentials(credentialsBlob());
	const token = await getToken();
	expect(token.accessToken).toBe('sk-ant-oat01-fixture');
	expect(token.source).toBe(process.platform === 'darwin' ? 'keychain' : 'file');
	expect(token.scopes).toContain('user:mcp_servers');
});

test('the env var takes precedence over a credentials file', async () => {
	writeCredentials(credentialsBlob());
	process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-from-env';
	const token = await getToken();
	expect(token.accessToken).toBe('sk-ant-oat01-from-env');
	expect(token.source).toBe('env');
});

test('throws AuthError naming the path when no credentials exist', async () => {
	await expect(getToken()).rejects.toThrow(AuthError);
	await expect(getToken()).rejects.toThrow(join(tmpDir, '.credentials.json'));
});

test('throws AuthError when the stored token has expired', async () => {
	writeCredentials(credentialsBlob({expiresAt: Date.now() - 60_000}));
	await expect(getToken()).rejects.toThrow(AuthError);
	await expect(getToken()).rejects.toThrow(/expired/i);
});

test('throws AuthError when the token lacks the user:mcp_servers scope', async () => {
	writeCredentials(credentialsBlob({scopes: ['user:inference', 'user:profile']}));
	await expect(getToken()).rejects.toThrow(AuthError);
	await expect(getToken()).rejects.toThrow(/user:mcp_servers/);
});

test('treats a malformed credentials file as missing credentials', async () => {
	writeCredentials('not json at all');
	await expect(getToken()).rejects.toThrow(AuthError);
});
