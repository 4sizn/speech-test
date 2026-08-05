/**
 * Time allowed for a streaming ASR server to serialize queued partial work and
 * deliver its final result after receiving `{ type: 'stop' }`.
 *
 * The prior 6s deadline severed valid finals under load, creating blank
 * hypotheses (CER 100%). Keep this constant independently testable so a future
 * timeout reduction cannot silently reintroduce that data-loss path.
 */
export const FINAL_DRAIN_TIMEOUT_MS = 20_000;

/** Minimal socket surface needed while waiting for the server's terminal close. */
export interface ClosableStreamingSocket {
  addEventListener(type: 'close', listener: () => void, options?: AddEventListenerOptions): void;
}

/** Resolve at server close or only after the bounded final-delivery deadline. */
export function awaitSocketCloseOrTimeout(socket: ClosableStreamingSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, FINAL_DRAIN_TIMEOUT_MS);
    socket.addEventListener(
      'close',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
