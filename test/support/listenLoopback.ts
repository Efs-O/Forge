import { createServer, type Server } from 'node:net';
// The blocked-port list has one owner (src/util/fetchBlockedPorts.ts); this file
// only rebinds a loopback listener until the port it got is one fetch accepts.
import { isFetchBlockedPort } from '../../src/util/fetchBlockedPorts';

export async function listenLoopback(
  server: Server,
  host = '127.0.0.1',
  isBlockedPort: (port: number) => boolean = isFetchBlockedPort,
): Promise<number> {
  // Rebind only when Fetch would block the assigned port before connecting.
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, host);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Loopback server did not bind to a TCP port');
    }
    const { port } = address;
    if (!isBlockedPort(port)) return port;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

export async function findFreeLoopbackPort(host = '127.0.0.1'): Promise<number> {
  const server = createServer();
  const port = await listenLoopback(server, host);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
