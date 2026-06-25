import { EventCategory } from './events.js';

/**
 * RxJS Subject의 최소 구현(의존성 없는 브라우저용).
 * next/subscribe만 제공하며, subscribe는 해지 함수를 돌려준다.
 *
 * @template T
 */
export class Subject {
  /** @type {Set<(value: any) => void>} */
  #observers = new Set();

  /**
   * 구독한다.
   * @param {(value: T) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    this.#observers.add(fn);
    return () => this.#observers.delete(fn);
  }

  /** 값을 흘려보낸다. */
  next(value) {
    // 순회 중 구독 해지에 안전하도록 스냅샷
    for (const fn of [...this.#observers]) {
      try {
        fn(value);
      } catch (err) {
        console.error('[Subject] observer threw', err);
      }
    }
  }

  /** 스트림을 종료한다. */
  complete() {
    this.#observers.clear();
  }
}

/**
 * @typedef {Object} BusMessage
 * @property {string} category - EventCategory (system | feature)
 * @property {string} type     - dot-namespace 이벤트 타입
 * @property {any}    payload
 * @property {number} ts
 */

/**
 * SDK 통합 이벤트 버스.
 *
 * RVS MessageBus와 동일하게 단일 Subject로 모든 메시지를 관리하고,
 * 카테고리/타입으로 필터된 파생 스트림을 제공한다.
 * "시스템 이벤트"와 "기능 이벤트"를 별도 채널로 구독할 수 있는 것이 핵심.
 *
 * @example
 * bus.feature(m => render(m));            // 기능 이벤트만 (STT 결과)
 * bus.system(m => updateStatus(m));       // 시스템 이벤트만 (상태/생명주기)
 * bus.on(FeatureEvent.TRANSCRIPT_FINAL, m => append(m.payload.text));
 */
export class EventBus {
  /** @type {Subject<BusMessage>} */
  #subject = new Subject();

  /**
   * 메시지를 발행한다.
   * @param {string} category
   * @param {string} type
   * @param {any} payload
   */
  emit(category, type, payload = {}) {
    this.#subject.next({ category, type, payload, ts: Date.now() });
  }

  /** 전체 메시지 스트림 (messages$). */
  messages(fn) {
    return this.#subject.subscribe(fn);
  }

  /** system 카테고리만 (system$). */
  system(fn) {
    return this.#subject.subscribe((m) => {
      if (m.category === EventCategory.SYSTEM) fn(m);
    });
  }

  /** feature 카테고리만 (feature$). */
  feature(fn) {
    return this.#subject.subscribe((m) => {
      if (m.category === EventCategory.FEATURE) fn(m);
    });
  }

  /** 특정 타입만 (on$). */
  on(type, fn) {
    return this.#subject.subscribe((m) => {
      if (m.type === type) fn(m);
    });
  }

  destroy() {
    this.#subject.complete();
  }
}
