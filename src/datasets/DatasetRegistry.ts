import type { DatasetAdapter, DatasetAdapterClass } from './DatasetAdapter';
import type { FileTreeIndex } from './FileTreeIndex';

/**
 * 데이터셋 어댑터 레지스트리.
 *
 * ProviderRegistry와 동일한 역할: 합성 루트에서 어댑터 클래스를 등록하고,
 * 폴더 인덱스가 들어오면 detect()로 해석 가능한 어댑터를 찾아 인스턴스를 만든다.
 * 새 "독립 샘플"은 어댑터 클래스 하나 만들어 register()만 추가하면 된다.
 */
export class DatasetRegistry {
  #adapters: DatasetAdapterClass[] = [];

  register(AdapterClass: DatasetAdapterClass): this {
    this.#adapters.push(AdapterClass);
    return this;
  }

  list(): Array<{ id: string; label: string }> {
    return this.#adapters.map((A) => ({ id: A.id, label: A.label }));
  }

  /** 인덱스를 해석할 수 있는 첫 어댑터의 인스턴스를 반환. 없으면 null. */
  detect(index: FileTreeIndex): DatasetAdapter | null {
    for (const A of this.#adapters) {
      try {
        if (A.detect(index)) return new A(index);
      } catch (err) {
        console.warn(`[DatasetRegistry] ${A.id} detect 실패`, err);
      }
    }
    return null;
  }
}
