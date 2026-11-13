import readline from 'node:readline';

// A server whose names and schemas are awkward on purpose: the bridge has to
// advertise a safe name, call the server with this one, and say what the
// engine's constrained decoding will not enforce.
const tools = [
  {
    name: 'vendor.tool.with.dots',
    description: 'Reports the name it was called by.',
    inputSchema: {
      type: 'object',
      properties: { where: { type: 'string', format: 'email' } },
    },
  },
  {
    name: 'ok_name',
    description: 'Already a safe name; the bridge must leave it alone.',
    inputSchema: { type: 'object', properties: { oneOf: { type: 'string' } } },
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
        serverInfo: { name: 'forge-name-boundary-mcp', version: '1.0.0' },
      };
      break;
    case 'tools/list':
      result = { tools };
      break;
    case 'tools/call':
      // Echoes the name the bridge actually sent, which is the server's own.
      result = { content: [{ type: 'text', text: `called:${request.params.name}` }] };
      break;
    default:
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`,
      );
      continue;
  }

  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}
