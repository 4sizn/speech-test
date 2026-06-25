/**
 * Provider 레지스트리 = 의존성 주입 컨테이너.
 *
 * Provider 클래스를 id로 등록해두고, 엔진이 요청하면 설정과 함께 인스턴스를 만들어 준다.
 * 새 Provider(예: Qwen3, Whisper, Deepgram...)는 여기에 register()만 하면
 * 엔진/UI 코드를 고치지 않고 모드로 주입된다. (개방-폐쇄 원칙)
 */
export class ProviderRegistry {
  /** @type {Map<string, typeof import('./SttProvider.js').SttProvider>} */
  #factories = new Map();

  /**
   * Provider 클래스를 등록한다.
   * @param {typeof import('./SttProvider.js').SttProvider} ProviderClass
   */
  register(ProviderClass) {
    this.#factories.set(ProviderClass.id, ProviderClass);
    return this;
  }

  has(id) {
    return this.#factories.has(id);
  }

  /**
   * 등록된 Provider 메타 목록(UI용).
   * @returns {Array<{id:string,label:string,capabilities:string[],supported:boolean}>}
   */
  list() {
    return [...this.#factories.values()].map((C) => ({
      id: C.id,
      label: C.label,
      capabilities: C.capabilities,
      configSchema: C.configSchema,
      supported: C.isSupported(),
    }));
  }

  /**
   * 인스턴스를 생성한다.
   * @param {string} id
   * @param {object} [config]
   * @returns {import('./SttProvider.js').SttProvider}
   */
  create(id, config = {}) {
    const C = this.#factories.get(id);
    if (!C) {
      throw new Error(
        `[ProviderRegistry] Unknown provider: "${id}". ` +
          `Available: [${[...this.#factories.keys()].join(', ')}]`,
      );
    }
    return new C(config);
  }
}
