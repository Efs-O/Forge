import readline from 'node:readline';

const tools = [
  {
    name: 'dispatch_subagent',
    description: 'Delegates a bounded consultation to a subagent.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
];

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;

  let result;
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge-test-mcp', version: '1.0.0' },
      };
      break;
    case 'tools/list':
      result = { tools };
      break;
    case 'tools/call':
      result = { content: [{ type: 'text', text: 'delegated result' }] };
      break;
    default:
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`,
      );
      continue;
  }

  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}
