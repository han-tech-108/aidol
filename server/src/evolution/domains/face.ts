import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { askJson } from "../../ai.ts";
import type { Domain } from "../engine.ts";
import { EMOTIONS, FACE_EXPRESSIONS, type CaptureImage, type FaceParams } from "../../protocol.ts";
import { step } from "./bounds.ts";

/** AI の提案を、今の値から一定幅以内・有効範囲内に収める。 */
export function boundedFace(cur: FaceParams, next: FaceParams): FaceParams {
  const emotions = {} as FaceParams["emotions"];
  for (const e of EMOTIONS) {
    emotions[e] = {};
    for (const x of FACE_EXPRESSIONS) {
      const v = step(cur.emotions[e]?.[x] ?? 0, next.emotions[e]?.[x] ?? 0, 0.15, 0, 1);
      if (v > 0.001) emotions[e][x] = Math.round(v * 100) / 100;
    }
  }
  const blinkMin = step(cur.blinkMin, next.blinkMin, 0.15, 0.8, 6);
  return {
    emotions,
    mouthGain: step(cur.mouthGain, next.mouthGain, 0.15, 0.5, 1.3),
    blinkMin,
    blinkMax: Math.max(blinkMin + 0.5, step(cur.blinkMax, next.blinkMax, 0.15, 2, 10)),
    gazeJitter: step(cur.gazeJitter, next.gazeJitter, 0.15, 0, 0.5),
  };
}

/** 撮影した顔の画像を、AI に見せられる形に並べる */
export function imageBlocks(images: CaptureImage[]): Anthropic.ContentBlockParam[] {
  return images.flatMap((img) => [
    { type: "text" as const, text: `感情: ${img.emotion}` },
    { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: img.png } },
  ]);
}

const Review = z.object({
  change: z.boolean(),
  rationale: z.string().describe("今の顔の評価と、何をなぜ変えるか。運営者向けに日本語で2〜3文"),
  emotions: z
    .array(z.object({ emotion: z.enum(EMOTIONS), expression: z.enum(FACE_EXPRESSIONS), weight: z.number().describe("0〜1") }))
    .describe("感情ごとの表情の強さ。1つの感情に複数の表情を混ぜてもよい。neutral は空でよい"),
  mouthGain: z.number().describe("口の開き具合の倍率。0.5〜1.3"),
  blinkMin: z.number().describe("まばたき間隔の最短（秒）"),
  blinkMax: z.number().describe("まばたき間隔の最長（秒）"),
  gazeJitter: z.number().describe("視線のゆらぎ。0〜0.5"),
});

/** 表情（感情ごとの表情の強さ、口パク、まばたき、視線）。撮影した顔を AI が見て調整する。 */
export function faceDomain(opts: { initial: FaceParams; capture: () => Promise<CaptureImage[]>; apply: (f: FaceParams) => void }): Domain<FaceParams> {
  return {
    id: "face",
    label: "表情",
    initial: opts.initial,
    minMinutes: 60,
    cooldownMinutes: 180,
    async propose({ current, stats }) {
      const out = await askJson({
        schema: Review,
        system: "あなたはバーチャルアイドルの表情演出を担当するアートディレクターです。VRM モデルの表情（BlendShape）の重みと、まばたき・視線・口パクの調整値を少しずつ改善します。",
        content: [
          ...imageBlocks(await opts.capture()),
          {
            type: "text",
            text: [
              `いまの調整値（版${current.version}）:`,
              JSON.stringify(current.value, null, 2),
              "",
              "版ごとの視聴者の反応:",
              stats,
              "",
              "上の画像は各感情を表示したときの顔です。表情が伝わりやすく、魅力的に見えるように改善案を出してください。",
              "不自然さ（目が閉じすぎる、口が開きすぎる、表情が弱くて伝わらない等）を優先して直し、変える必要の無い値はそのままにしてください。",
            ].join("\n"),
          },
        ],
      });
      if (!out.change) return null;
      const emotions = Object.fromEntries(EMOTIONS.map((e) => [e, {}])) as FaceParams["emotions"];
      for (const x of out.emotions) emotions[x.emotion][x.expression] = x.weight;
      return {
        rationale: out.rationale,
        value: { emotions, mouthGain: out.mouthGain, blinkMin: out.blinkMin, blinkMax: out.blinkMax, gazeJitter: out.gazeJitter },
      };
    },
    sanitize: boundedFace,
    apply: opts.apply,
  };
}
