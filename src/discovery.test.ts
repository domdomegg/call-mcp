import {test, expect} from 'vitest';
import {resolveServer, DiscoveryError, type McpServer} from './discovery.js';

const servers: McpServer[] = [
	{
		id: 'mcpsrv_aggregator',
		display_name: 'Aggregator',
		url: 'https://mcp.example.com/mcp',
		created_at: '2026-03-04T15:33:05Z',
	},
	{
		id: 'mcpsrv_gdrive',
		display_name: 'Google Drive',
		url: 'https://drivemcp.example.com/mcp/v1',
		created_at: '2025-10-05T12:46:57Z',
	},
	{
		id: 'mcpsrv_gcal',
		display_name: 'Google Calendar',
		url: 'https://calmcp.example.com/mcp',
		created_at: '2026-01-01T00:00:00Z',
	},
];

test('resolves by exact id', () => {
	expect(resolveServer(servers, 'mcpsrv_gdrive').display_name).toBe('Google Drive');
});

test('resolves by exact display name', () => {
	expect(resolveServer(servers, 'Aggregator').id).toBe('mcpsrv_aggregator');
});

test('resolves by display name case-insensitively', () => {
	expect(resolveServer(servers, 'aggregator').id).toBe('mcpsrv_aggregator');
	expect(resolveServer(servers, 'GOOGLE DRIVE').id).toBe('mcpsrv_gdrive');
});

test('resolves by unique case-insensitive prefix', () => {
	expect(resolveServer(servers, 'agg').id).toBe('mcpsrv_aggregator');
	expect(resolveServer(servers, 'google d').id).toBe('mcpsrv_gdrive');
});

test('throws on an ambiguous prefix, listing the matches', () => {
	expect(() => resolveServer(servers, 'google')).toThrow(DiscoveryError);
	expect(() => resolveServer(servers, 'google')).toThrow(/Google Drive/);
	expect(() => resolveServer(servers, 'google')).toThrow(/Google Calendar/);
});

test('throws when nothing matches', () => {
	expect(() => resolveServer(servers, 'nonexistent')).toThrow(DiscoveryError);
	expect(() => resolveServer(servers, 'nonexistent')).toThrow(/No MCP server matches/);
});

test('prefers an exact name over a prefix that would be ambiguous', () => {
	const withExact: McpServer[] = [
		...servers,
		{
			id: 'mcpsrv_g', display_name: 'Google', url: 'https://g.example.com', created_at: '2026-01-01T00:00:00Z',
		},
	];
	// "Google" is now an exact name even though it is also a prefix of two others.
	expect(resolveServer(withExact, 'Google').id).toBe('mcpsrv_g');
});
