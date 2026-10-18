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
export function score(e: Exposure | undefined, minMinutes: number): number | null {
  if (!e || e.minutes < minMinutes) return null;
  return ((e.comments + 5 * e.positives - 10 * e.negatives) / e.minutes) * 60;
}

interface MetricsData {
  exposure: Record<string, Exposure>;
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

  /** 配信中に1分ごとに呼ぶ。 */
  tick(active: ActiveVersions, minutes = 1) {
    for (const d of DOMAINS) this.at(d, active[d]).minutes += minutes;
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
  const rows = Object.entries(m.all(d)).map(([v, e]) => {
    const s = score(e, minMinutes);
    return `- 版${v}: ${Math.round(e.minutes)}分、コメント${e.comments}件、褒め${e.positives}件、不満${e.negatives}件${s === null ? "（比較にはまだ短い）" : `、評価点${s.toFixed(1)}/時`}`;
  });
  return rows.length ? rows.join("\n") : "（まだデータがありません）";
}
