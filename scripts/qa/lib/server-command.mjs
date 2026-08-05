/**
 * Builds the faster-whisper server command used by controlled QA experiments.
 * The optional model is deliberately explicit in argv: the report/launcher must
 * never rely on whichever server default happens to be checked out.
 */
/** Parse the optional controlled-model QA flag without accepting a missing value. */
export function fasterWhisperModelFromArgs(args = []) {
  const index = args.indexOf('--faster-whisper-model');
  if (index === -1) return undefined;
  const model = args[index + 1];
  if (!model || model.startsWith('--')) throw new Error('--faster-whisper-model requires a model');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(model)) throw new Error(`invalid faster-whisper model: ${model}`);
  return model;
}

export function fasterWhisperCommand({ script, port, model, maxUtteranceSec } = {}) {
  if (typeof script !== 'string' || !script) throw new Error('server script is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid server port: ${port}`);
  if (model !== undefined && !/^[a-z0-9][a-z0-9._-]*$/i.test(model)) {
    throw new Error(`invalid faster-whisper model: ${model}`);
  }
  if (maxUtteranceSec !== undefined && (!Number.isFinite(maxUtteranceSec) || maxUtteranceSec <= 0)) {
    throw new Error(`invalid max utterance seconds: ${maxUtteranceSec}`);
  }
  const command = [script, '--engine', 'faster-whisper', '--port', String(port)];
  if (model) command.push('--model', model);
  if (maxUtteranceSec !== undefined) command.push('--max-utterance-sec', String(maxUtteranceSec));
  return command;
}
