/**
 * 마이크 경로 수동 검증 — 진짜 `getUserMedia` 트랙에 음성을 흘려 넣는다.
 *
 *   node scripts/qa/verify-mic.mjs [provider] [location] [관찰ms]
 *   node scripts/qa/verify-mic.mjs whisper local-client 45000
 *
 * ## 왜 별도 도구인가
 *
 * `npm run qa:stt`의 마이크 모드는 `getUserMedia`를 **JS로 오버라이드**해 `<audio>`의
 * `captureStream()` 트랙을 돌려준다(`src/qa/harness.ts`). 편리하지만 사각지대가 있다 —
 * Provider가 트랙을 그대로 인식 API에 넘기는 경우, 그 측정은 **파일 트랙 경로를 다시 테스트**한다.
 * 실제로 WebSpeech에서 마이크 트랙만 실패하는 결함이 그 측정을 CER 5.0%로 통과했다.
 *
 * 여기서는 Chrome 플래그로 브라우저 레벨의 가짜 입력을 쓴다:
 *   --use-file-for-fake-audio-capture=<wav>
 * `getUserMedia`가 **실제 장치 트랙**(label이 물리 장치명)을 돌려주고 그 안에 wav가 흐른다.
 *
 * ⚠ `--use-fake-device-for-media-stream`을 **함께 주면 안 된다** — 그 플래그가 1kHz 톤
 *   생성기를 켜서 파일을 덮는다(실측: 파일 플래그와 같이 주면 rms 0.0000, 단독이면 0.11).
 *
 * ## 한계 — 이 도구로 검증되는 것과 안 되는 것
 *
 * - ✅ `getUserMedia` 스트림을 **직접 소비**하는 Provider: Whisper·Streaming·FunASR·SenseVoice
 *   (`AudioPcmTap`으로 PCM을 읽는다)
 * - ❌ **WebSpeech**: 가짜 파일 캡처가 SpeechRecognition의 오디오 스택에 닿지 않는다. 실측으로
 *   `rec.start(micTrack)` / `rec.start()` / 마이크→AudioContext 경유 트랙이 모두 결과 0건인데,
 *   같은 환경에서 `<audio>` captureStream 트랙은 149건 인식됐다. → WebSpeech 마이크는
 *   **사람이 물리 마이크로 확인해야 한다.**
 * - 인식 **정확도**는 이 도구로 판단하지 않는다. getUserMedia 경로는 브라우저가 에코 제거·
 *   노이즈 억제·자동 게인을 적용하고 리샘플하므로 오디오가 변형된다. 여기서 보는 것은
 *   "중간 자막이 흐르는가 / 확정이 나오는가 / 메인 스레드가 멈추지 않는가"다.
 *   정확도는 `npm run qa:stt`(CER)로 본다.
 *
 * 입력 wav는 `--wav`로 지정하거나, 기본값으로 `.qa-tmp/mic-input.wav`를 쓴다
 * (16bit PCM. 데이터셋에서 만들려면 scripts/qa/lib/dataset.mjs의 materializeSample 사용).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const PROJECT_ROOT = new URL('../..', import.meta.url).pathname;
const args = process.argv.slice(2);
const val = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

const PROVIDER = positional[0] ?? 'whisper';
const LOCATION = positional[1] ?? 'local-client';
const RUN_MS = Number(positional[2] ?? 45000);
const WAV = val('wav', join(PROJECT_ROOT, '.qa-tmp/mic-input.wav'));
const CHROME = process.env.STT_QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_APP = val('url', 'http://localhost:5173/');
const SHOT = join(PROJECT_ROOT, '.qa-tmp/mic-flowing.png');

const LOC_LABEL = { 'local-client': '로컬(클라이언트)', 'remote-cloud': '클라우드', 'remote-onpremise': '온프레미스' };

if (!existsSync(WAV)) {
  console.error(`입력 wav가 없습니다: ${WAV}\n  --wav <path>로 지정하거나 데이터셋에서 생성하세요.`);
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`Chrome을 찾을 수 없습니다: ${CHROME} (STT_QA_CHROME로 지정 가능)`);
  process.exit(1);
}
if (PROVIDER === 'webspeech') {
  console.log('⚠ WebSpeech는 이 도구로 검증되지 않는다(가짜 파일 캡처가 인식 오디오 스택에 닿지 않음).');
  console.log('  물리 마이크로 직접 확인하세요. 자세한 근거는 이 파일 상단 주석 참고.\n');
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  defaultViewport: { width: 1500, height: 950 },
  args: [
    '--use-fake-ui-for-media-stream', // 권한 프롬프트 자동 허용
    `--use-file-for-fake-audio-capture=${WAV}`, // getUserMedia가 이 wav를 흘린다
    '--autoplay-policy=no-user-gesture-required',
    '--disable-component-update', // SODA 언어팩 유입 차단(측정 결정론)
    '--disable-features=CalculateNativeWinOcclusion',
  ],
});

try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  page.on('console', (m) => {
    if (m.type() === 'error' && !/onnxruntime|VerifyEachNode/.test(m.text())) {
      console.log(`  [browser:error] ${m.text().slice(0, 160)}`);
    }
  });
  await page.goto(URL_APP, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));

  await page.evaluate(
    async (provider, locLabel) => {
      const setSel = (id, v) => {
        const e = document.getElementById(id);
        e.value = v;
        e.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setSel('provider-select', provider);
      setSel('lang-select', 'ko-KR');
      await new Promise((r) => setTimeout(r, 400));
      const byText = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(t));
      byText(locLabel)?.click();
      await new Promise((r) => setTimeout(r, 300));
      byText('마이크')?.click();
      await new Promise((r) => setTimeout(r, 400));
      document.getElementById('btn-clear')?.click();
    },
    PROVIDER,
    LOC_LABEL[LOCATION] ?? LOC_LABEL['local-client'],
  );

  const cfg = await page.evaluate(() => ({
    provider: document.getElementById('provider-select').value,
    loc: [...document.querySelectorAll('button')]
      .filter((b) => /로컬|온프레미스|클라우드/.test(b.textContent))
      .map((b) => b.textContent.trim() + (b.className.includes('active') ? ' ←' : ''))
      .join(' '),
    mode: [...document.querySelectorAll('button')]
      .filter((b) => /마이크|파일/.test(b.textContent))
      .map((b) => b.textContent.trim() + (b.className.includes('active') ? ' ←' : ''))
      .join(' '),
  }));
  console.log(`설정: ${cfg.provider} · ${cfg.loc} · ${cfg.mode}`);

  await page.evaluate(() => {
    const interim = document.getElementById('interim');
    const transcript = document.getElementById('transcript');
    const statusEl = document.getElementById('status-text');
    const log = { t0: performance.now(), partials: [], finals: [], status: [], gaps: [], maxGap: 0 };
    window.__mic = log;
    const at = () => Math.round(performance.now() - log.t0);
    new MutationObserver(() => {
      const t = (interim.textContent || '').trim();
      const last = log.partials.at(-1);
      if (t && (!last || last.text !== t)) log.partials.push({ t: at(), text: t });
    }).observe(interim, { childList: true, subtree: true, characterData: true });
    new MutationObserver(() => {
      const lines = [...transcript.querySelectorAll('.line')].map((e) => e.textContent.trim());
      if (lines.length !== log.finals.length) log.finals = lines.map((s) => ({ t: at(), text: s }));
    }).observe(transcript, { childList: true, subtree: true });
    new MutationObserver(() => log.status.push({ t: at(), text: statusEl.textContent })).observe(statusEl, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    let prev = performance.now();
    const tick = () => {
      const now = performance.now();
      const gap = now - prev;
      prev = now;
      if (gap > 100) log.gaps.push(Math.round(gap));
      if (gap > log.maxGap) log.maxGap = Math.round(gap);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.getElementById('btn-start').click();
  });

  console.log(`인식 시작 — ${RUN_MS / 1000}초 관찰`);
  // 중간 자막이 화면에 뜬 순간을 캡처한다(사람이 눈으로 확인할 증거)
  void (async () => {
    for (let i = 0; i < 400; i++) {
      const t = await page
        .evaluate(() => (document.getElementById('interim').textContent || '').trim())
        .catch(() => '');
      if (t && t !== '…인식 중' && t.length > 8) {
        await page.screenshot({ path: SHOT }).catch(() => {});
        console.log(`  📸 중간 자막 포착 → ${SHOT}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  await new Promise((r) => setTimeout(r, RUN_MS));

  const out = await page.evaluate(() => {
    const l = window.__mic;
    return {
      partials: l.partials.filter((p) => p.text && p.text !== '…인식 중'),
      placeholders: l.partials.filter((p) => p.text === '…인식 중').length,
      finals: l.finals,
      status: l.status,
      maxGap: l.maxGap,
      longGaps: l.gaps.length,
    };
  });

  console.log(`\n── 중간 자막(partial) ${out.partials.length}회 ──`);
  for (const p of out.partials) console.log(`  ${(p.t / 1000).toFixed(1)}s  ${p.text.slice(0, 70)}`);
  console.log(`\n── 확정 자막(final) ${out.finals.length}건 ──`);
  for (const f of out.finals) {
    console.log(
      `  ${f.text
        .replace(/^\S+·\S+/, '')
        .trim()
        .slice(0, 70)}`,
    );
  }
  console.log(`\n── 상태 변화 ──`);
  for (const s of out.status.slice(0, 8)) console.log(`  ${(s.t / 1000).toFixed(1)}s  ${s.text.slice(0, 90)}`);
  console.log(`\n최대 프레임 갭 ${out.maxGap}ms · 100ms 초과 ${out.longGaps}회 · 자리표시 ${out.placeholders}회`);

  const flowing = out.partials.length >= 2;
  const recognized = out.finals.length >= 1;
  console.log(`\n판정: 흐르는 자막 ${flowing ? '✅' : '❌'} · 확정 결과 ${recognized ? '✅' : '❌'}`);
  if (!flowing && recognized) {
    console.log(
      '  ※ 확정분을 증분으로 흘리는 엔진(FunASR·whisper-streaming)은 partial을 보내지 않는다 —',
      '\n    자막이 확정 줄로 쌓이면 정상이다. 이 경우 "흐르는 자막 ❌"는 결함이 아니다.',
    );
  }
  console.log('(정확도는 판단 대상이 아니다 — 브라우저 오디오 전처리로 변형된다. CER은 npm run qa:stt)');
  process.exitCode = flowing && recognized ? 0 : 1;
} finally {
  await browser.close();
}
