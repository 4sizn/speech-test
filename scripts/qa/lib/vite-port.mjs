import { createServer } from 'node:net';

const FORBIDDEN_PORT = 5173;

function assertValid(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid QA Vite port: ${port}`);
  }
  if (port === FORBIDDEN_PORT) {
    throw new Error(`QA Vite port ${FORBIDDEN_PORT} is forbidden: it can target a user's dev server`);
  }
}

async function reserveKernelPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

/**
 * Selects a QA-only Vite port. Port 5173 is never eligible because it may be a
 * human's running dev server; QA must spawn and measure its own worktree server.
 */
export async function selectQaVitePort(requestedPort = 0) {
  const requested = Number(requestedPort);
  assertValid(requested);
  if (requested) return requested;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await reserveKernelPort();
    if (port !== FORBIDDEN_PORT) return port;
  }
  throw new Error('failed to reserve a non-5173 QA Vite port');
}
