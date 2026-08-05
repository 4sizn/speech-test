import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { createQaChromeProfile } from './chrome-profile.mjs';

const first = createQaChromeProfile();
const second = createQaChromeProfile();
try {
  assert.notEqual(first, second, 'concurrent QA runs must never share Chrome userDataDir');
  assert.ok(existsSync(first), 'first isolated profile must exist');
  assert.ok(existsSync(second), 'second isolated profile must exist');
  assert.match(first, /chrome-profile-run-/);
  assert.match(second, /chrome-profile-run-/);
  console.log('chrome-profile: concurrent QA runs receive isolated user-data directories');
} finally {
  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
}
