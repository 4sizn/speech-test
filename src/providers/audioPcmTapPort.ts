import type { PcmTapFactory } from '@rsupport/rvs-stt-kit/streaming';

export interface AudioPcmTapLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type AudioPcmTapCtor = new (
  stream: MediaStream,
  options: { onFrame: (pcm: Float32Array) => void },
) => AudioPcmTapLike;

/**
 * Keep speech-test's proven browser PCM capture path while delegating socket
 * transport/final-drain behavior to rvs-stt-kit.
 */
export function createAudioPcmTapFactory(
  AudioPcmTapImpl: AudioPcmTapCtor,
): PcmTapFactory {
  return (stream, onFrame) =>
    new AudioPcmTapImpl(stream as MediaStream, {
      onFrame,
    });
}
