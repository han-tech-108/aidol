import type { EvolutionStatus } from "../protocol.ts";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../store.ts";
import { describeStats, score, type ActiveVersions, type DomainId, type Metrics } from "./metrics.ts";
import { VersionedStore, type Versioned } from "./versioned.ts";

/** 候補の評価点が、元の版のこの割合以上なら採用する（少し悪くても探索を続けるため 1 未満） */
export const KEEP_RATIO = 0.9;

export interface ProposeContext<T> {
  current: Versioned<T>;
  /** 版ごとの視聴者の反応（日本語） */
  stats: string;
  metrics: Metrics;
}

export interface Proposal<T> {
  value: T;
  rationale: string;
}

/** AI が自分で改善する項目1つ分。 */
export interface Domain<T> {
  id: Exclude<DomainId, "look">;
  label: string;
  initial: T;
  /** 評価に必要な使用時間（分） */
  minMinutes: number;
  /** 次の改善を試すまでにあける配信時間（分） */
  cooldownMinutes: number;
  /** AI に改善案を出させる */
  propose(ctx: ProposeContext<T>): Promise<Proposal<T> | null>;
  /** 安全な範囲・一度に変えてよい幅に収める */
  sanitize(prev: T, next: T): T;
  /** 配信中のシステムに反映する */
  apply(value: T): Promise<void> | void;
}

export type EvolutionEvent = {
  domain: DomainId;
  kind: "proposed" | "kept" | "reverted" | "skipped" | "error";
  message: string;
};

interface Experiment {
  domain: Exclude<DomainId, "look">;
  baseline: number;
  candidate: number;
  startedAtLiveMinute: number;
}

interface EngineState {
  paused: boolean;
  frozen: DomainId[];
  liveMinutes: number;
  lastRun: Partial<Record<DomainId, number>>;
  active: Experiment | null;
}

/**
 * 自己改善エンジン。
 * 配信中に1つずつ項目を選び、「AI が改善案を出す → 一定時間使う → 視聴者の反応を元の版と比べる → 残すか戻す」を繰り返す。
 * 効果を見分けるため、同時に試すのは1項目だけ。
 */
export class EvolutionEngine {
  private domains = new Map<string, Domain<unknown>>();
  private stores = new Map<string, VersionedStore<unknown>>();
  private state: EngineState;
  private busy = false;
  onEvent: (e: EvolutionEvent) => void = () => {};

  constructor(
    private dir: string,
    private metrics: Metrics,
    private lookVersion: () => string,
  ) {
    this.state = readJson<EngineState>(path.join(dir, "state.json"), { paused: false, frozen: [], liveMinutes: 0, lastRun: {}, active: null });
  }

  register<T>(d: Domain<T>) {
    this.domains.set(d.id, d as Domain<unknown>);
    this.stores.set(d.id, new VersionedStore<T>(path.join(this.dir, d.id), d.initial) as VersionedStore<unknown>);
  }

  value<T>(id: string): T {
    return this.stores.get(id)!.current.value as T;
  }
  version(id: string): number {
    return this.stores.get(id)?.current.version ?? 0;
  }

  /** 起動時に、保存されている今の版をシステムに反映する */
  async applyAll() {
    for (const [id, d] of this.domains) await d.apply(this.stores.get(id)!.current.value);
  }

  activeVersions(): ActiveVersions {
    const v = (id: string) => String(this.version(id));
    return { persona: v("persona"), voice: v("voice"), face: v("face"), motion: v("motion"), model: v("model"), look: this.lookVersion() };
  }

  /** 配信中に1分ごとに呼ぶ */
  async tick() {
    this.state.liveMinutes++;
    this.save();
    if (this.busy) return;
    const a = this.state.active;
    if (a) {
      const d = this.domains.get(a.domain)!;
      if (this.metrics.stats(a.domain, String(a.candidate)).minutes >= d.minMinutes) await this.judge();
      return;
    }
    if (this.state.paused) return;
    const next = this.nextDomain();
    if (next) await this.experiment(next);
  }

  /** 運営者が「今すぐ改善」を押したとき（進行中の実験があれば先に判定する） */
  async runNow(id: string) {
    if (this.busy || !this.domains.has(id)) return;
    if (this.state.active) await this.judge(true);
    await this.experiment(id);
  }

  /** 1つ前の版に戻す */
  async revert(id: string) {
    const store = this.stores.get(id);
    const prev = store?.previous();
    if (!store || prev == null) return;
    if (this.state.active?.domain === id) this.state.active = null;
    const v = store.restore(prev)!;
    await this.domains.get(id)!.apply(v.value);
    this.emit({ domain: id as DomainId, kind: "reverted", message: `運営者が版${prev}に戻しました` });
    this.save();
  }

  setPaused(paused: boolean) {
    this.state.paused = paused;
    this.save();
  }
  setFrozen(id: string, frozen: boolean) {
    if (!this.domains.has(id as never)) return;
    this.state.frozen = frozen ? [...new Set([...this.state.frozen, id as DomainId])] : this.state.frozen.filter((x) => x !== id);
    this.save();
  }

  status(): EvolutionStatus {
    return {
      paused: this.state.paused,
      liveMinutes: this.state.liveMinutes,
      active: this.state.active,
      domains: [...this.domains.values()].map((d) => {
        const cur = this.stores.get(d.id)!.current;
        return { id: d.id, label: d.label, version: cur.version, rationale: cur.rationale, frozen: this.state.frozen.includes(d.id) };
      }),
    };
  }

  private nextDomain(): string | null {
    const ready = [...this.domains.values()].filter((d) => {
      if (this.state.frozen.includes(d.id)) return false;
      const last = this.state.lastRun[d.id];
      return last === undefined || this.state.liveMinutes - last >= d.cooldownMinutes;
    });
    // いちばん長く試していない項目から
    ready.sort((a, b) => (this.state.lastRun[a.id] ?? -1) - (this.state.lastRun[b.id] ?? -1));
    return ready[0]?.id ?? null;
  }

  private async experiment(id: string) {
    const d = this.domains.get(id)!;
    const store = this.stores.get(id)!;
    this.busy = true;
    this.state.lastRun[d.id] = this.state.liveMinutes;
    try {
      const proposal = await d.propose({ current: store.current, stats: describeStats(this.metrics, d.id, d.minMinutes), metrics: this.metrics });
      if (!proposal) return this.emit({ domain: d.id, kind: "skipped", message: "今回は変更なし" });
      const value = d.sanitize(store.current.value, proposal.value);
      if (JSON.stringify(value) === JSON.stringify(store.current.value)) {
        return this.emit({ domain: d.id, kind: "skipped", message: `変更なし（${proposal.rationale}）` });
      }
      const baseline = store.current.version;
      const next = store.commit(value, proposal.rationale);
      await d.apply(value);
      this.state.active = { domain: d.id, baseline, candidate: next.version, startedAtLiveMinute: this.state.liveMinutes };
      this.emit({ domain: d.id, kind: "proposed", message: `版${next.version}を試します: ${proposal.rationale}` });
    } catch (e) {
      this.emit({ domain: d.id, kind: "error", message: (e as Error).message });
    } finally {
      this.busy = false;
      this.save();
    }
  }

  /** 候補の版と元の版の反応を比べて、残すか戻すかを決める */
  private async judge(early = false) {
    const a = this.state.active;
    if (!a) return;
    const d = this.domains.get(a.domain)!;
    const store = this.stores.get(a.domain)!;
    this.state.active = null;
    const base = score(this.metrics.stats(a.domain, String(a.baseline)), d.minMinutes);
    const cand = score(this.metrics.stats(a.domain, String(a.candidate)), early ? 0 : d.minMinutes);
    if (base !== null && cand !== null && cand < base * KEEP_RATIO) {
      const v = store.restore(a.baseline)!;
      await d.apply(v.value);
      this.emit({ domain: a.domain, kind: "reverted", message: `版${a.candidate}は反応が下がったため版${a.baseline}に戻しました（評価点 ${cand.toFixed(1)} < ${base.toFixed(1)}）` });
    } else {
      const detail = base === null || cand === null ? "比較できるデータが足りないため" : `評価点 ${cand.toFixed(1)}（元 ${base.toFixed(1)}）`;
      this.emit({ domain: a.domain, kind: "kept", message: `版${a.candidate}を採用しました（${detail}）` });
    }
    this.save();
  }

  private emit(e: EvolutionEvent) {
    const file = path.join(this.dir, "changelog.md");
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(file)) appendFileSync(file, "# AIドル 自己改善の記録\n\n");
    const label = this.domains.get(e.domain)?.label ?? e.domain;
    appendFileSync(file, `- ${new Date().toISOString()} [${label}] ${e.kind}: ${e.message}\n`);
    this.onEvent(e);
  }

  private save() {
    writeJson(path.join(this.dir, "state.json"), this.state);
  }
}
