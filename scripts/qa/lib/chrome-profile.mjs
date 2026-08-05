import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Creates a per-run Chrome profile outside the persistent QA evidence tree.
 * A shared profile lets concurrent runners attach to one browser or fail at launch,
 * contaminating the same-day A/B sequence with process-order effects.
 */
export function createQaChromeProfile() {
  return mkdtempSync(join(tmpdir(), 'speech-test-chrome-profile-run-'));
}
