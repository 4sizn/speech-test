import { Mode } from '../core/events.ts';
import type { EngineProfile } from '../profiles/engineProfiles.ts';
import type { SttServiceInput } from '@rsupport/rvs-stt-kit';

export interface BootstrapProfileSnapshot {
  readonly profile: EngineProfile | null;
  readonly mode: Mode;
  readonly file: unknown;
}

export interface ResolvedBootstrapProfile {
  readonly profile: EngineProfile;
  readonly input: SttServiceInput;
}

export class BootstrapProfileResolver {
  readonly #readSnapshot: () => BootstrapProfileSnapshot;

  constructor(readSnapshot: () => BootstrapProfileSnapshot) {
    this.#readSnapshot = readSnapshot;
  }

  isServiceProfile(): boolean {
    return this.#readSnapshot().profile?.providerId === 'streaming';
  }

  resolve(expectedInput?: SttServiceInput): ResolvedBootstrapProfile {
    const snapshot = this.#readSnapshot();
    const profile = snapshot.profile;
    if (!profile) throw new Error('No EngineProfile selected for service bootstrap');
    if (profile.providerId !== 'streaming') {
      throw new Error(`[${profile.label}] is not service-managed`);
    }

    const input = this.#resolveInput(snapshot.mode, snapshot.file);
    if (expectedInput) this.#assertMatchingInput(expectedInput, input);
    return { profile, input };
  }

  #resolveInput(mode: Mode, file: unknown): SttServiceInput {
    if (mode === Mode.MIC) return { kind: 'microphone' };
    if (mode === Mode.FILE) {
      if (!file) throw new Error('Streaming service file mode requires a selected file');
      return { kind: 'file', file };
    }
    throw new Error(`Streaming service does not support ${mode} mode`);
  }

  #assertMatchingInput(expectedInput: SttServiceInput, resolvedInput: SttServiceInput): void {
    if (expectedInput.kind !== resolvedInput.kind) {
      throw new Error(`Service input mismatch: expected ${resolvedInput.kind}, got ${expectedInput.kind}`);
    }
    if (
      expectedInput.kind === 'file' &&
      resolvedInput.kind === 'file' &&
      expectedInput.file !== resolvedInput.file
    ) {
      throw new Error('Service input mismatch: file selection changed');
    }
  }
}
