import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./store.ts";
import { complimentRate, type PreferenceTracker } from "./preferences.ts";
import { EMOTIONS, FACE_EXPRESSIONS, type CaptureImage, type FaceParams, type Look } from "./protocol.ts";

/** 1回のレビューで動かしてよい幅。急に別人の顔にならないようにする。 */
const MAX_STEP = 0.15;
/** 新しい版の反応が、前の版のこの割合を下回ったら元に戻す。 */
const ROLLBACK_RATIO = 0.7;
/** 版どうしを比べるのに必要な表示時間（分）。 */
const MIN_MINUTES_TO_COMPARE = 60;

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const step = (from: number, to: number, lo: number, hi: number) => clamp(clamp(to, from - MAX_STEP, from + MAX_STEP), lo, hi);

/** AI の提案を、今の値から一定幅以内・有効範囲内に収める。 */
export function boundedUpdate(cur: FaceParams, proposal: Omit<FaceParams, "version" | "note">): Omit<FaceParams, "version" | "note"> {
  const emotions = {} as FaceParams["emotions"];
  for (const e of EMOTIONS) {
    emotions[e] = {};
    for (const x of FACE_EXPRESSIONS) {
      const v = step(cur.emotions[e]?.[x] ?? 0, proposal.emotions[e]?.[x] ?? 0, 0, 1);
      if (v > 0.001) emotions[e][x] = Math.round(v * 100) / 100;
    }
  }
  const blinkMin = step(cur.blinkMin, proposal.blinkMin, 0.8, 6);
  return {
    emotions,
    mouthGain: step(cur.mouthGain, proposal.mouthGain, 0.5, 1.3),
    blinkMin,
    blinkMax: Math.max(blinkMin + 0.5, step(cur.blinkMax, proposal.blinkMax, 2, 10)),
    gazeJitter: step(cur.gazeJitter, proposal.gazeJitter, 0, 0.5),
  };
}

const Review = z.object({
  assessment: z.string().describe("今の顔の見せ方の評価。運営者向けに日本語で2〜3文"),
  emotions: z
    .array(
      z.object({
        emotion: z.enum(EMOTIONS),
        expression: z.enum(FACE_EXPRESSIONS),
        weight: z.number().describe("0〜1"),
      }),
    )
    .describe("感情ごとの表情の強さ。1つの感情に複数の表情を混ぜてもよい。neutral は空でよい"),
  mouthGain: z.number().describe("口の開き具合の倍率。0.5〜1.3"),
  blinkMin: z.number().describe("まばたき間隔の最短（秒）"),
  blinkMax: z.number().describe("まばたき間隔の最長（秒）"),
  gazeJitter: z.number().describe("視線のゆらぎ。0〜0.5"),
  modelSuggestions: z
    .array(z.string())
    .describe("調整値では直せず、3Dモデル自体（VRoid等）の修正が必要な改善点。具体的に。無ければ空"),
});

export type ReviewOutcome =
  | { kind: "updated"; params: FaceParams; assessment: string; modelSuggestions: string[] }
  | { kind: "rolled-back"; params: FaceParams; reason: string };

/**
 * 顔の継続改良。
 * 1. アバターに感情ごとの顔を撮影させる
 * 2. 視聴者の反応（版ごとの褒め言葉の多さ）と画像を AI に見せ、調整値の改善案をもらう
 * 3. 一定幅以内で反映して新しい版として保存する。前の版より反応が悪ければ元に戻す
 * モデル自体の修正が必要な点は model-suggestions.md に貯め、制作者が VRoid などで直す。
 */
export class FaceTuner {
  private client = new Anthropic();
  params: FaceParams;

  constructor(
    private dir: string,
    defaults: FaceParams,
    private prefs: PreferenceTracker,
    private model: string,
  ) {
    this.params = readJson<FaceParams>(path.join(dir, "current.json"), defaults);
    if (!existsSync(this.versionFile(this.params.version))) writeJson(this.versionFile(this.params.version), this.params);
  }

  /** 反応が前の版より明らかに悪ければ、前の版に戻す。戻したら理由を返す。 */
  checkRollback(): ReviewOutcome | null {
    const prev = this.previousVersion();
    if (prev === null) return null;
    const stats = this.prefs.faceVersions;
    const cur = complimentRate(stats[String(this.params.version)], MIN_MINUTES_TO_COMPARE);
    const old = complimentRate(stats[String(prev)], MIN_MINUTES_TO_COMPARE);
    if (cur === null || old === null || old === 0 || cur >= old * ROLLBACK_RATIO) return null;
    const restored = readJson<FaceParams | null>(this.versionFile(prev), null);
    if (!restored) return null;
    const reason = `版${this.params.version}の褒め言葉が1時間あたり${cur.toFixed(1)}件で、版${prev}の${old.toFixed(1)}件を大きく下回ったため`;
    this.commit({ ...restored, note: `版${prev}に戻した（${reason}）` });
    return { kind: "rolled-back", params: this.params, reason };
  }

  rollback(): FaceParams | null {
    const prev = this.previousVersion();
    if (prev === null) return null;
    const restored = readJson<FaceParams | null>(this.versionFile(prev), null);
    if (!restored) return null;
    this.commit({ ...restored, note: `運営者が版${prev}に戻した` });
    return this.params;
  }

  async review(images: CaptureImage[], look: Look): Promise<ReviewOutcome> {
    const auto = this.checkRollback();
    if (auto) return auto;

    const stats = Object.entries(this.prefs.faceVersions)
      .map(([v, s]) => `- 版${v}: 表示${Math.round(s.minutes)}分、コメント${s.comments}件、褒め言葉${s.compliments}件`)
      .join("\n");
    const content: Anthropic.ContentBlockParam[] = [];
    for (const img of images) {
      content.push({ type: "text", text: `感情: ${img.emotion}` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: img.png } });
    }
    content.push({
      type: "text",
      text: [
        `いまの見た目: ${look.name}（${look.hair}）`,
        `いまの調整値（版${this.params.version}）:`,
        JSON.stringify({ ...this.params, note: undefined }, null, 2),
        "",
        "版ごとの視聴者の反応:",
        stats || "（まだデータがありません）",
        "",
        "上の画像は各感情を表示したときのアバターの顔です。表情が伝わりやすく、かわいく見えるように調整値の改善案を出してください。",
        "不自然さ（目が閉じすぎる、口が開きすぎる、表情が弱くて伝わらない等）を優先して直してください。変える必要が無い値はそのままにしてください。",
      ].join("\n"),
    });

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 8192,
      output_config: { effort: "medium", format: zodOutputFormat(Review) },
      system: "あなたはバーチャルアイドルの表情演出を担当するアートディレクターです。VRM モデルの表情（BlendShape）の重みと、まばたき・視線・口パクの調整値を少しずつ改善します。",
      messages: [{ role: "user", content }],
    });
    const out = response.parsed_output;
    if (!out) throw new Error("顔のレビュー結果を読み取れませんでした");

    const proposal = { emotions: {} as FaceParams["emotions"], mouthGain: out.mouthGain, blinkMin: out.blinkMin, blinkMax: out.blinkMax, gazeJitter: out.gazeJitter };
    for (const e of EMOTIONS) proposal.emotions[e] = {};
    for (const x of out.emotions) proposal.emotions[x.emotion][x.expression] = x.weight;

    this.commit({ ...boundedUpdate(this.params, proposal), version: this.latestVersion() + 1, note: out.assessment }, true);
    if (out.modelSuggestions.length) this.saveSuggestions(out.modelSuggestions, look);
    return { kind: "updated", params: this.params, assessment: out.assessment, modelSuggestions: out.modelSuggestions };
  }

  /** isNew: 新しい版として履歴に残すか（元に戻すときは残さない） */
  private commit(p: FaceParams, isNew = false) {
    this.params = p;
    writeJson(path.join(this.dir, "current.json"), p);
    if (isNew) writeJson(this.versionFile(p.version), p);
  }

  private versions(): number[] {
    const dir = path.join(this.dir, "history");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
      .filter((x): x is string => !!x)
      .map(Number)
      .sort((a, b) => a - b);
  }
  private latestVersion() {
    return Math.max(this.params.version, ...this.versions());
  }
  private previousVersion(): number | null {
    const older = this.versions().filter((v) => v < this.params.version);
    return older.length ? older[older.length - 1]! : null;
  }
  private versionFile(v: number) {
    return path.join(this.dir, "history", `v${v}.json`);
  }

  private saveSuggestions(items: string[], look: Look) {
    const file = path.join(this.dir, "model-suggestions.md");
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(file)) appendFileSync(file, "# 顔の改善メモ（3Dモデル自体の修正が必要なもの）\n\nAI の顔レビューで見つかった、調整値では直せない改善点です。VRoid などでモデルを直したら、新しい VRM を wardrobe.json に登録してください。\n");
    appendFileSync(file, `\n## ${new Date().toISOString()} ${look.name}（版${this.params.version}）\n${items.map((s) => `- ${s}`).join("\n")}\n`);
  }
}
