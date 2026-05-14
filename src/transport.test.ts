import {test, expect} from 'vitest';
import {parseBody} from './transport.js';

test('parses a plain JSON-RPC object body', () => {
	const raw = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}';
	expect([...parseBody(raw)]).toEqual([
		{jsonrpc: '2.0', id: 1, result: {ok: true}},
	]);
});

test('parses a single SSE message frame', () => {
	const raw = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
	expect([...parseBody(raw)]).toEqual([
		{jsonrpc: '2.0', id: 1, result: {}},
	]);
});

test('parses multiple SSE frames in one body', () => {
	const raw = [
		'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":1}',
		'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":2}',
	].join('\n\n');
	expect([...parseBody(raw)]).toEqual([
		{jsonrpc: '2.0', id: 1, result: 1},
		{jsonrpc: '2.0', id: 2, result: 2},
	]);
});

test('joins multi-line data fields within a frame', () => {
	const raw = 'event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":{}}\n\n';
	expect([...parseBody(raw)]).toEqual([
		{jsonrpc: '2.0', id: 1, result: {}},
	]);
});

test('ignores SSE frames that carry no data line', () => {
	const raw = ': a comment\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
	expect([...parseBody(raw)]).toEqual([
		{jsonrpc: '2.0', id: 1, result: {}},
	]);
});

test('handles surrounding whitespace', () => {
	const raw = '\n\n  {"jsonrpc":"2.0","id":1,"result":{}}  \n';
	expect([...parseBody(raw)]).toEqual([
		{jsonrpc: '2.0', id: 1, result: {}},
	]);
});
