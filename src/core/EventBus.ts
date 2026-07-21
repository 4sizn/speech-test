import { EventCategory } from './events';

/**
 * RxJS Subject의 최소 구현(의존성 없는 브라우저용).
 * next/subscribe만 제공하며, subscribe는 해지 함수를 돌려준다.
 */
export class Subject<T> {
  #observers = new Set<(value: T) => void>();

  /** 구독한다. @returns unsubscribe */
  subscribe(fn: (value: T) => void): () => void {
    this.#observers.add(fn);
    return () => this.#observers.delete(fn);
  }

  /** 값을 흘려보낸다. */
  next(value: T): void {
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
  complete(): void {
    this.#observers.clear();
  }
}

/** 버스로 흐르는 단일 메시지. */
export interface BusMessage {
  /** EventCategory (system | feature) */
  category: EventCategory;
  /** dot-namespace 이벤트 타입 */
  type: string;
  // 이벤트 타입마다 형태가 달라 소비처에서 좁혀 쓴다
  payload: any;
  ts: number;
}

export type BusListener = (message: BusMessage) => void;

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
  #subject = new Subject<BusMessage>();

  /** 메시지를 발행한다. */
  emit(category: EventCategory, type: string, payload: unknown = {}): void {
    this.#subject.next({ category, type, payload, ts: Date.now() });
  }

  /** 전체 메시지 스트림 (messages$). */
  messages(fn: BusListener): () => void {
    return this.#subject.subscribe(fn);
  }

  /** system 카테고리만 (system$). */
  system(fn: BusListener): () => void {
    return this.#subject.subscribe((m) => {
      if (m.category === EventCategory.SYSTEM) fn(m);
    });
  }

  /** feature 카테고리만 (feature$). */
  feature(fn: BusListener): () => void {
    return this.#subject.subscribe((m) => {
      if (m.category === EventCategory.FEATURE) fn(m);
    });
  }

  /** 특정 타입만 (on$). */
  on(type: string, fn: BusListener): () => void {
    return this.#subject.subscribe((m) => {
      if (m.type === type) fn(m);
    });
  }

  destroy(): void {
    this.#subject.complete();
  }
}
