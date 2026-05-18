import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {ProxyTransport} from './transport.js';

/** Opens an initialized MCP session to a claude.ai server via the proxy. */
export async function connect(serverId: string, accessToken: string): Promise<Client> {
	const transport = new ProxyTransport(serverId, accessToken);
	const client = new Client(
		{name: 'call-mcp', version: '0.1.0'},
		{capabilities: {}},
	);
	await client.connect(transport);
	return client;
}

export async function listTools(client: Client): Promise<Tool[]> {
	const res = await client.listTools();
	return res.tools;
}

export async function callTool(
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	return client.callTool({name, arguments: args});
}
