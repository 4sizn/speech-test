/**
 * 폴더 트리를 "상대경로 → 파일" 인덱스로 정규화한다.
 *
 * 데이터셋이 로컬 디스크 어디에 있든, 어떤 방식으로 들어오든
 * (File System Access API 핸들 / webkitdirectory FileList / 테스트 주입 entries)
 * 어댑터는 이 인덱스 하나만 보고 동작한다.
 *
 * 경로는 항상 '/' 구분자·NFC 정규화(한글 폴더명 macOS NFD 이슈 방지)로 통일한다.
 */
export class FileTreeIndex {
  /** @type {Map<string, File|FileSystemFileHandle>} */
  #entries = new Map();
  /** @type {string[]} */
  #paths = [];
  /** 사용자에게 보여줄 소스 이름(폴더명 등) */
  sourceName = '';

  static #norm(path) {
    return path.normalize('NFC').replace(/\\/g, '/');
  }

  /** File System Access API 디렉터리 핸들에서 생성(파일은 지연 로드). */
  static async fromDirectoryHandle(dirHandle) {
    const index = new FileTreeIndex();
    index.sourceName = dirHandle.name;
    async function walk(handle, prefix) {
      for await (const entry of handle.values()) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.kind === 'directory') await walk(entry, path);
        else index.#set(path, entry);
      }
    }
    await walk(dirHandle, '');
    index.#seal();
    return index;
  }

  /** <input webkitdirectory>의 FileList에서 생성. */
  static fromFileList(fileList) {
    const index = new FileTreeIndex();
    for (const f of fileList) {
      const rel = f.webkitRelativePath || f.name;
      index.#set(rel, f);
    }
    const firstPath = index.#paths[0] || '';
    index.sourceName = firstPath.split('/')[0] || '(폴더)';
    index.#seal();
    return index;
  }

  /** 테스트/프로그램 주입용: [{path, file}] 배열에서 생성. */
  static fromEntries(entries, sourceName = '(주입)') {
    const index = new FileTreeIndex();
    for (const { path, file } of entries) index.#set(path, file);
    index.sourceName = sourceName;
    index.#seal();
    return index;
  }

  #set(path, fileOrHandle) {
    const p = FileTreeIndex.#norm(path);
    this.#entries.set(p, fileOrHandle);
    this.#paths.push(p);
  }

  #seal() {
    this.#paths.sort();
  }

  /** 전체 상대경로 목록(정렬됨). */
  get paths() {
    return this.#paths;
  }

  get size() {
    return this.#paths.length;
  }

  has(path) {
    return this.#entries.has(FileTreeIndex.#norm(path));
  }

  /** @returns {Promise<File>} */
  async file(path) {
    const entry = this.#entries.get(FileTreeIndex.#norm(path));
    if (!entry) throw new Error(`인덱스에 없는 경로: ${path}`);
    return typeof entry.getFile === 'function' ? entry.getFile() : entry;
  }

  async readText(path) {
    const f = await this.file(path);
    return f.text();
  }

  async readJson(path) {
    return JSON.parse(await this.readText(path));
  }
}
