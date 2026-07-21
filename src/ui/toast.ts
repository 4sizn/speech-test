/**
 * 경량 토스트 알림.
 *
 * 상태바(statusbar)는 마지막 상태 한 줄만 보여줘서 "모델 로딩 중" 같은
 * 일시적이지만 중요한 알림이 묻히기 쉽다. 토스트는 화면 우상단에 쌓이고
 * 자동으로 사라진다. 컨테이너는 최초 호출 시 body에 생성한다.
 */

export type ToastKind = 'info' | 'ok' | 'warn' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  /** ms. 0이면 자동 닫힘 없음(수동 닫기만). */
  duration?: number;
}

let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (container && document.body.contains(container)) return container;
  container = document.createElement('div');
  container.className = 'toast-container';
  container.setAttribute('role', 'status');
  container.setAttribute('aria-live', 'polite');
  document.body.appendChild(container);
  return container;
}

/** 토스트를 띄운다. 반환된 함수로 즉시 닫을 수 있다. */
export function showToast(message: string, { kind = 'info', duration = 3500 }: ToastOptions = {}): () => void {
  const root = ensureContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = { info: 'ℹ', ok: '✓', warn: '⏳', error: '✕' }[kind];
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  toast.append(icon, text);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    toast.classList.add('toast-out');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    // transition 미발생 대비 백스톱
    setTimeout(() => toast.remove(), 400);
  };

  toast.addEventListener('click', close);
  root.appendChild(toast);
  if (duration > 0) setTimeout(close, duration);
  return close;
}
