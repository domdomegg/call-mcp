import {
	describe, test, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileOAuthClientProvider, oauthCacheDir} from './oauth.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'call-mcp-oauth-test-'));
	vi.stubEnv('XDG_CONFIG_HOME', tempDir);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(tempDir, {recursive: true, force: true});
});

describe('FileOAuthClientProvider storage', () => {
	test('persists tokens and client information across instances', async () => {
		const first = await FileOAuthClientProvider.create('homelab', 'https://mcp.example.com/mcp');
		expect(first.tokens()).toBeUndefined();

		await first.saveClientInformation({client_id: 'registered-client'});
		await first.saveTokens({access_token: 'token-123', token_type: 'Bearer', refresh_token: 'refresh-456'});

		const second = await FileOAuthClientProvider.create('homelab', 'https://mcp.example.com/mcp');
		expect(second.tokens()).toMatchObject({access_token: 'token-123', refresh_token: 'refresh-456'});
		expect(second.clientInformation()).toEqual({client_id: 'registered-client'});

		const cacheFile = join(oauthCacheDir(), 'homelab.json');
		const raw = JSON.parse(await readFile(cacheFile, 'utf8'));
		expect(raw.serverUrl).toBe('https://mcp.example.com/mcp');
	});

	test('ignores cached state when the server URL has changed', async () => {
		const first = await FileOAuthClientProvider.create('homelab', 'https://old.example.com/mcp');
		await first.saveTokens({access_token: 'old-token', token_type: 'Bearer'});

		const second = await FileOAuthClientProvider.create('homelab', 'https://new.example.com/mcp');
		expect(second.tokens()).toBeUndefined();
	});

	test('static client credentials from the config take precedence', async () => {
		const provider = await FileOAuthClientProvider.create('homelab', 'https://mcp.example.com/mcp', {
			client_id: 'static-client',
			client_secret: 'static-secret',
			scope: 'mcp.read',
		});
		await provider.saveClientInformation({client_id: 'registered-client'});

		expect(provider.clientInformation()).toEqual({client_id: 'static-client', client_secret: 'static-secret'});
		expect(provider.clientMetadata.scope).toBe('mcp.read');
		expect(provider.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post');
	});

	test('invalidateCredentials clears the requested scope', async () => {
		const provider = await FileOAuthClientProvider.create('homelab', 'https://mcp.example.com/mcp');
		await provider.saveClientInformation({client_id: 'registered-client'});
		await provider.saveTokens({access_token: 'token-123', token_type: 'Bearer'});

		await provider.invalidateCredentials('tokens');
		expect(provider.tokens()).toBeUndefined();
		expect(provider.clientInformation()).toEqual({client_id: 'registered-client'});
	});
});

describe('FileOAuthClientProvider authorization callback', () => {
	test('resolves with the code delivered to the loopback redirect URL', async () => {
		const provider = await FileOAuthClientProvider.create('homelab', 'https://mcp.example.com/mcp');
		const redirect = new URL(provider.redirectUrl);
		expect(redirect.hostname).toBe('127.0.0.1');

		const waiting = provider.waitForAuthorizationCode();
		redirect.searchParams.set('code', 'auth-code-789');
		redirect.searchParams.set('state', provider.state());
		const res = await fetch(redirect);
		expect(res.status).toBe(200);

		await expect(waiting).resolves.toBe('auth-code-789');
	});

	test('rejects on a state mismatch', async () => {
		const provider = await FileOAuthClientProvider.create('homelab', 'https://mcp.example.com/mcp');
		const redirect = new URL(provider.redirectUrl);

		// Attach the rejection expectation before triggering the callback, so the
		// rejection is always observed.
		const waiting = expect(provider.waitForAuthorizationCode()).rejects.toThrowError(/state mismatch/);
		redirect.searchParams.set('code', 'auth-code-789');
		redirect.searchParams.set('state', 'wrong-state');
		const res = await fetch(redirect);
		expect(res.status).toBe(400);

		await waiting;
	});
});
