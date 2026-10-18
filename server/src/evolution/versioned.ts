import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../store.ts";

export interface Versioned<T> {
  version: number;
  value: T;
  /** なぜこの版にしたか */
  rationale: string;
  at: string;
}

/** 設定値を版ごとに保存する。current.json が今の版、history/v{n}.json が過去の版。 */
export class VersionedStore<T> {
  current: Versioned<T>;

  constructor(
    private dir: string,
    initial: T,
  ) {
    this.current = readJson<Versioned<T>>(path.join(dir, "current.json"), {
      version: 1,
      value: initial,
      rationale: "初期値",
      at: new Date().toISOString(),
    });
    if (!existsSync(this.file(this.current.version))) this.persist(true);
  }

  /** 新しい版として保存して切り替える。 */
  commit(value: T, rationale: string): Versioned<T> {
    this.current = { version: this.latest() + 1, value, rationale, at: new Date().toISOString() };
    this.persist(true);
    return this.current;
  }

  /** 過去の版に戻す（新しい版は作らない）。 */
  restore(version: number): Versioned<T> | null {
    const v = this.get(version);
    if (!v) return null;
    this.current = v;
    this.persist(false);
    return v;
  }

  get(version: number): Versioned<T> | null {
    return readJson<Versioned<T> | null>(this.file(version), null);
  }

  /** 今の版より前で、いちばん新しい版 */
  previous(): number | null {
    const older = this.versions().filter((v) => v < this.current.version);
    return older.length ? older.at(-1)! : null;
  }

  versions(): number[] {
    const dir = path.join(this.dir, "history");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
      .filter((x): x is string => !!x)
      .map(Number)
      .sort((a, b) => a - b);
  }

  private latest() {
    return Math.max(this.current.version, ...this.versions());
  }
  private file(v: number) {
    return path.join(this.dir, "history", `v${v}.json`);
  }
  private persist(withHistory: boolean) {
    writeJson(path.join(this.dir, "current.json"), this.current);
    if (withHistory) writeJson(this.file(this.current.version), this.current);
  }
}
