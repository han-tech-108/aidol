import { readJson, writeJson } from "./store.ts";
import type { Comment } from "./protocol.ts";

export interface ExposureStats {
  /** 表示していた時間（分） */
  minutes: number;
  comments: number;
  /** 「かわいい」「似合う」など見た目を褒めるコメントの数 */
  compliments: number;
}

export interface AppearanceRequest {
  at: string;
  author: string;
  text: string;
}

interface PreferenceData {
  looks: Record<string, ExposureStats>;
  faceVersions: Record<string, ExposureStats>;
  requests: AppearanceRequest[];
}

const COMPLIMENT = /かわい|可愛|カワイ|きれい|綺麗|キレイ|似合|好き|すき|最高|かっこい|美人|cute|kawaii|pretty|beautiful/i;
const APPEARANCE = /着替|衣装|服|髪|ヘア|ポニテ|ポニーテール|ツインテ|おだんご|お団子|ショート|ロング|メイク|パジャマ|制服|水着|ドレス|浴衣|コスプレ|outfit|hair/i;
const MAX_REQUESTS = 50;

export const isCompliment = (text: string) => COMPLIMENT.test(text);
export const isAppearanceTalk = (text: string) => APPEARANCE.test(text);

const empty = (): ExposureStats => ({ minutes: 0, comments: 0, compliments: 0 });

/**
 * 視聴者の好みを記録する。
 * 見た目（衣装・顔の版）ごとに、表示時間・コメント数・褒め言葉の数を数え、
 * 見た目についてのリクエストを残しておく。
 */
export class PreferenceTracker {
  private data: PreferenceData;

  constructor(private file: string) {
    this.data = readJson<PreferenceData>(file, { looks: {}, faceVersions: {}, requests: [] });
  }

  /** 1分ごとに呼ぶ。 */
  tick(lookId: string, faceVersion: number, minutes = 1) {
    this.look(lookId).minutes += minutes;
    this.face(faceVersion).minutes += minutes;
    this.save();
  }

  /** コメントを記録する。見た目についての話なら true を返す。 */
  observe(c: Comment, lookId: string, faceVersion: number): boolean {
    const look = this.look(lookId);
    const face = this.face(faceVersion);
    look.comments++;
    face.comments++;
    if (isCompliment(c.text)) {
      look.compliments++;
      face.compliments++;
    }
    const aboutAppearance = isAppearanceTalk(c.text);
    if (aboutAppearance) {
      this.data.requests.push({ at: new Date().toISOString(), author: c.author, text: c.text });
      this.data.requests = this.data.requests.slice(-MAX_REQUESTS);
    }
    this.save();
    return aboutAppearance;
  }

  get looks() {
    return this.data.looks;
  }
  get faceVersions() {
    return this.data.faceVersions;
  }
  recentRequests(n = 20) {
    return this.data.requests.slice(-n);
  }

  private look(id: string) {
    return (this.data.looks[id] ??= empty());
  }
  private face(version: number) {
    return (this.data.faceVersions[String(version)] ??= empty());
  }
  private save() {
    writeJson(this.file, this.data);
  }
}

/** 1時間あたりの褒め言葉の数。表示時間が短すぎるものは比べられないので null。 */
export function complimentRate(s: ExposureStats | undefined, minMinutes = 30): number | null {
  if (!s || s.minutes < minMinutes) return null;
  return (s.compliments / s.minutes) * 60;
}
