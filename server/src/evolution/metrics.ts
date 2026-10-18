import { readJson, writeJson } from "../store.ts";
import type { Comment } from "../protocol.ts";

/** AI が調整する項目。look は衣装・髪型の組み合わせ（版 = Look の id）。 */
export const DOMAINS = ["persona", "voice", "face", "motion", "model", "look"] as const;
export type DomainId = (typeof DOMAINS)[number];
/** いま表示・使用中の版。domain → 版の名前 */
export type ActiveVersions = Record<DomainId, string>;

export interface Exposure {
  /** 使っていた時間（分） */
  minutes: number;
  /** その間のコメント数（盛り上がりの目安） */
  comments: number;
  /** その項目を褒めるコメント */
  positives: number;
  /** その項目への不満コメント */
  negatives: number;
  /** スーパーチャット・メンバー加入などの件数 */
  gifts?: number;
  /** 同時視聴者数が分かっていた時間（分） */
  watchedMinutes?: number;
  /** 同時視聴者数 × 分（視聴者数の合計） */
  viewerMinutes?: number;
  /** その間の同時視聴者数の増減の合計 */
  viewerChange?: number;
  /** アーカイブの視聴維持率から求めた、視聴者が離れた割合の合計（配信後に加算） */
  retentionDrop?: number;
  /** 視聴維持率を対応づけられた時間（分） */
  retentionMinutes?: number;
}

/** 評価点の出し方。viewers は同時視聴者数で割った値（視聴者が多い時間帯に有利にならない） */
export type ScoreMode = "comments" | "viewers";

/** 同時視聴者数で比べられるだけのデータがあるか */
export const hasViewerData = (e: Exposure | undefined) => !!e && (e.watchedMinutes ?? 0) >= e.minutes / 2 && (e.viewerMinutes ?? 0) > 0;

/** 比べる版がすべて視聴者数のデータを持っていれば viewers で比べる */
export function scoreMode(...es: (Exposure | undefined)[]): ScoreMode {
  return es.every(hasViewerData) ? "viewers" : "comments";
}

/** 配信1回分の記録。アーカイブの視聴維持率を、そのとき使っていた版に対応づけるために使う。 */
export interface LiveSession {
  videoId: string;
  /** 配信の開始時刻（アーカイブの0秒） */
  startedAt: string;
  /** 使っていた版が変わった時刻 */
  segments: { at: string; active: ActiveVersions }[];
  retentionDone?: boolean;
}

export interface AppearanceRequest {
  at: string;
  author: string;
  text: string;
}

const NEGATIVE = /つまらな|飽き|うるさ|きも|キモ|下手|微妙|変だ|変な|怖い|こわい|聞き取りにく|聞こえな|早口|遅い|暗い|しつこ|やめて|嫌|いや/;
const COMPLIMENT = /かわい|可愛|カワイ|きれい|綺麗|キレイ|似合|好き|すき|最高|かっこい|美人|素敵|すてき|いいね|cute|kawaii|pretty|beautiful|nice/i;

/** 項目ごとに「その項目の話をしている」とみなす言葉。 */
const TOPIC: Record<DomainId, RegExp> = {
  persona: /面白|おもしろ|笑|草|ｗｗ|ww|優しい|やさしい|天然|性格|話し方|トーク|返し|ツッコミ|キャラ/,
  voice: /声|ボイス|喋り方|しゃべり方|滑舌|発音|イントネーション|歌声/,
  face: /顔|表情|笑顔|目が|まばたき|口が/,
  motion: /動き|ダンス|手振|手を振|仕草|しぐさ|ジェスチャー|うなず/,
  model: /顔|目|肌|モデル|作画|線|影|綺麗|きれい/,
  look: /服|衣装|髪|ヘア|似合|ポニテ|ツインテ|おだんご|メイク|コーデ/,
};

const APPEARANCE = /着替|衣装|服|髪|ヘア|ポニテ|ポニーテール|ツインテ|おだんご|お団子|ショート|ロング|メイク|パジャマ|制服|水着|ドレス|浴衣|コスプレ|髪色|outfit|hair/i;
export const isAppearanceTalk = (text: string) => APPEARANCE.test(text);
export const isNegative = (text: string) => NEGATIVE.test(text);
export const isCompliment = (text: string) => COMPLIMENT.test(text) && !NEGATIVE.test(text);

/** コメントがどの項目への褒め言葉・不満かを判定する。 */
export function classify(text: string): Partial<Record<DomainId, "positive" | "negative">> {
  const out: Partial<Record<DomainId, "positive" | "negative">> = {};
  const neg = isNegative(text);
  const pos = COMPLIMENT.test(text);
  for (const d of DOMAINS) {
    if (!TOPIC[d].test(text)) continue;
    if (neg) out[d] = "negative";
    else if (pos || d === "persona") out[d] = "positive"; // 笑い・草などはそれ自体が好反応
  }
  // 何についてかは分からないが「かわいい」は見た目全般への好反応
  if (pos && !neg && !out.face && !out.look) out.face = out.look = "positive";
  return out;
}

/**
 * 1時間あたりの評価点。盛り上がり（コメント数）を土台に、褒め言葉で加点、不満で大きく減点する。
 * 使った時間が短すぎるものは比べられないので null。
 */
export function score(e: Exposure | undefined, minMinutes: number, mode: ScoreMode = scoreMode(e)): number | null {
  if (!e || e.minutes < minMinutes) return null;
  const reactions = e.comments + 5 * e.positives - 10 * e.negatives + 20 * (e.gifts ?? 0);
  if (mode === "comments" || !hasViewerData(e)) return (reactions / e.minutes) * 60;
  // 視聴者100人・1時間あたりの反応。視聴者が増えていく版は加点、減っていく版は減点
  const watched = e.watchedMinutes!;
  const avgViewers = e.viewerMinutes! / watched;
  const perViewer = ((reactions * (watched / e.minutes)) / e.viewerMinutes!) * 60 * 100;
  const growth = Math.max(-0.5, Math.min(0.5, (e.viewerChange ?? 0) / Math.max(1, avgViewers) / (watched / 60)));
  return perViewer * (1 + growth);
}

interface MetricsData {
  exposure: Record<string, Exposure>;
  sessions?: LiveSession[];
  requests: AppearanceRequest[];
  recent: { at: string; author: string; text: string }[];
}

const empty = (): Exposure => ({ minutes: 0, comments: 0, positives: 0, negatives: 0 });
const key = (d: DomainId, v: string) => `${d}@${v}`;

/** 視聴者の反応を、項目と版ごとに記録する。 */
export class Metrics {
  private data: MetricsData;

  constructor(private file: string) {
    this.data = readJson<MetricsData>(file, { exposure: {}, requests: [], recent: [] });
  }

  private lastViewers: number | null = null;

  /** 配信中に1分ごとに呼ぶ。viewers は今の同時視聴者数（分からなければ null）。 */
  tick(active: ActiveVersions, minutes = 1, viewers: number | null = null) {
    const change = viewers !== null && this.lastViewers !== null ? viewers - this.lastViewers : 0;
    for (const d of DOMAINS) {
      const e = this.at(d, active[d]);
      e.minutes += minutes;
      if (viewers !== null) {
        e.watchedMinutes = (e.watchedMinutes ?? 0) + minutes;
        e.viewerMinutes = (e.viewerMinutes ?? 0) + viewers * minutes;
        e.viewerChange = (e.viewerChange ?? 0) + change;
      }
    }
    this.lastViewers = viewers;
    const session = this.data.sessions?.at(-1);
    if (session && !session.retentionDone && JSON.stringify(session.segments.at(-1)?.active) !== JSON.stringify(active)) {
      session.segments.push({ at: new Date().toISOString(), active: { ...active } });
    }
    this.save();
  }

  /** YouTube の配信が見つかったとき。同じ配信なら何もしない。 */
  startSession(videoId: string, startedAt: string, active: ActiveVersions) {
    const sessions = (this.data.sessions ??= []);
    if (sessions.some((s) => s.videoId === videoId)) return;
    sessions.push({ videoId, startedAt, segments: [{ at: new Date().toISOString(), active: { ...active } }] });
    this.data.sessions = sessions.slice(-30);
    this.lastViewers = null;
    this.save();
  }

  /** 視聴維持率をまだ取り込んでいない配信 */
  pendingSessions(): LiveSession[] {
    return (this.data.sessions ?? []).filter((s) => !s.retentionDone);
  }

  /**
   * アーカイブの視聴維持率を、各時点で使っていた版に振り分ける。
   * curve は動画の経過割合（0〜1）ごとの視聴率。
   */
  addRetention(videoId: string, curve: { ratio: number; watch: number }[], durationSeconds: number) {
    const session = this.data.sessions?.find((s) => s.videoId === videoId);
    if (!session) return;
    const start = Date.parse(session.startedAt);
    const points = [...curve].sort((a, b) => a.ratio - b.ratio);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]!;
      const cur = points[i]!;
      const minutes = ((cur.ratio - prev.ratio) * durationSeconds) / 60;
      // 区間の真ん中の時刻で、どの版を使っていたかを決める
      const at = start + ((prev.ratio + cur.ratio) / 2) * durationSeconds * 1000;
      const seg = [...session.segments].reverse().find((s) => Date.parse(s.at) <= at) ?? session.segments[0];
      if (!seg || minutes <= 0) continue;
      for (const d of DOMAINS) {
        const e = this.at(d, seg.active[d]);
        e.retentionDrop = (e.retentionDrop ?? 0) + Math.max(0, prev.watch - cur.watch);
        e.retentionMinutes = (e.retentionMinutes ?? 0) + minutes;
      }
    }
    session.retentionDone = true;
    this.save();
  }

  /** スーパーチャット・メンバー加入など */
  observeGift(active: ActiveVersions) {
    for (const d of DOMAINS) {
      const e = this.at(d, active[d]);
      e.gifts = (e.gifts ?? 0) + 1;
    }
    this.save();
  }

  /** コメントを記録する。見た目についての話なら true を返す。 */
  observe(c: Comment, active: ActiveVersions): boolean {
    const verdicts = classify(c.text);
    for (const d of DOMAINS) {
      const e = this.at(d, active[d]);
      e.comments++;
      if (verdicts[d] === "positive") e.positives++;
      if (verdicts[d] === "negative") e.negatives++;
    }
    this.data.recent = [...this.data.recent, { at: new Date().toISOString(), author: c.author, text: c.text }].slice(-200);
    const appearance = isAppearanceTalk(c.text);
    if (appearance) this.data.requests = [...this.data.requests, { at: new Date().toISOString(), author: c.author, text: c.text }].slice(-50);
    this.save();
    return appearance;
  }

  stats(d: DomainId, version: string): Exposure {
    return this.data.exposure[key(d, version)] ?? empty();
  }

  /** ある項目の全版の記録 */
  all(d: DomainId): Record<string, Exposure> {
    const prefix = `${d}@`;
    return Object.fromEntries(
      Object.entries(this.data.exposure)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => [k.slice(prefix.length), v]),
    );
  }

  recentRequests(n = 20) {
    return this.data.requests.slice(-n);
  }
  recentComments(n = 50) {
    return this.data.recent.slice(-n);
  }

  private at(d: DomainId, v: string) {
    return (this.data.exposure[key(d, v)] ??= empty());
  }
  private save() {
    writeJson(this.file, this.data);
  }
}

/** AI に渡すための、版ごとの反応の一覧（日本語） */
export function describeStats(m: Metrics, d: DomainId, minMinutes = 30): string {
  const all = m.all(d);
  const mode = scoreMode(...Object.values(all).filter((e) => e.minutes >= minMinutes));
  const rows = Object.entries(all).map(([v, e]) => {
    const s = score(e, minMinutes, mode);
    const parts = [`${Math.round(e.minutes)}分`, `コメント${e.comments}件`, `褒め${e.positives}件`, `不満${e.negatives}件`];
    if (e.gifts) parts.push(`スパチャ・メンバー${e.gifts}件`);
    if (hasViewerData(e)) parts.push(`平均同時視聴者${Math.round(e.viewerMinutes! / e.watchedMinutes!)}人`, `視聴者の増減${e.viewerChange! >= 0 ? "+" : ""}${e.viewerChange}人`);
    if (e.retentionMinutes) parts.push(`アーカイブの離脱 10分あたり${((e.retentionDrop! / e.retentionMinutes) * 1000).toFixed(1)}%`);
    return `- 版${v}: ${parts.join("、")}${s === null ? "（比較にはまだ短い）" : `、評価点${s.toFixed(1)}`}`;
  });
  const note = mode === "viewers" ? "評価点は視聴者100人・1時間あたりの反応（視聴者の増減も加味）" : "評価点は1時間あたりの反応";
  return rows.length ? `${rows.join("\n")}\n（${note}。コメント+褒め×5−不満×10+スパチャ等×20）` : "（まだデータがありません）";
}
