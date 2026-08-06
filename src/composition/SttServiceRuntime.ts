import { FeatureEvent, SystemEvent } from '../core/events.ts';
import type { BootstrapProfileResolver } from './BootstrapProfileResolver.ts';
import type { SttServiceInput, SttServiceRun, SttServiceRuntime, SttServiceSink } from '@rsupport/rvs-stt-kit';

interface RuntimeBus {
  on(type: string, listener: (message: { payload: any }) => void): () => void;
}

interface EngineRuntimePort {
  readonly bus: RuntimeBus;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface EngineBackedSttServiceRuntimeOptions {
  readonly engine: EngineRuntimePort;
  readonly resolver: BootstrapProfileResolver;
}

class EngineBackedSttServiceRun implements SttServiceRun {
  readonly #engine: EngineRuntimePort;
  readonly #resolver: BootstrapProfileResolver;
  readonly #input: SttServiceInput;
  readonly #sink: SttServiceSink;
  #unsubscribe: Array<() => void> = [];

  constructor(options: EngineBackedSttServiceRuntimeOptions, input: SttServiceInput, sink: SttServiceSink) {
    this.#engine = options.engine;
    this.#resolver = options.resolver;
    this.#input = input;
    this.#sink = sink;
  }

  async start(): Promise<void> {
    this.#resolver.resolve(this.#input);
    this.#subscribe();
    try {
      await this.#engine.start();
    } catch (error) {
      this.#cleanup();
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.#engine.stop();
    } finally {
      this.#cleanup();
    }
  }

  async abort(): Promise<void> {
    await this.stop();
  }

  #subscribe(): void {
    if (this.#unsubscribe.length) return;
    this.#unsubscribe = [
      this.#engine.bus.on(FeatureEvent.TRANSCRIPT_PARTIAL, (message) => {
        this.#sink.partial(String(message.payload?.text ?? ''));
      }),
      this.#engine.bus.on(FeatureEvent.TRANSCRIPT_FINAL, (message) => {
        this.#sink.final(String(message.payload?.text ?? ''));
      }),
      this.#engine.bus.on(SystemEvent.RECOGNITION_ERROR, (message) => {
        this.#sink.error(new Error(String(message.payload?.message ?? 'STT runtime failed')));
      }),
    ];
  }

  #cleanup(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
  }
}

export function createEngineBackedSttServiceRuntime(
  options: EngineBackedSttServiceRuntimeOptions,
): SttServiceRuntime {
  return {
    createRun(input, sink) {
      return new EngineBackedSttServiceRun(options, input, sink);
    },
  };
}
