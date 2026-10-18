import { z } from "zod";
import { askJson } from "../../ai.ts";
import type { Domain } from "../engine.ts";
import type { CaptureImage, LookEdits } from "../../protocol.ts";
import { clamp, step } from "./bounds.ts";
import { imageBlocks } from "./face.ts";

/** モデル自体の見た目の調整（すべての衣装に共通でかかる） */
export interface ModelParams {
  /** 瞳の色。hue を省略すると元の色のまま */
  eye: { hue?: number; saturation: number; lightness: number };
  outlineScale: number;
  shadingToony: number;
  shadingShift: number;
  rimLift: number;
}

export const DEFAULT_MODEL: ModelParams = {
  eye: { saturation: 1, lightness: 0 },
  outlineScale: 1,
  shadingToony: 0.9,
  shadingShift: -0.05,
  rimLift: 0,
};

/** モデル調整を、VRM を作り直すための変更内容に変える */
export function modelEdits(m: ModelParams): LookEdits {
  const isDefault = JSON.stringify(m) === JSON.stringify(DEFAULT_MODEL);
  if (isDefault) return {};
  return {
    colors: { eye: m.eye },
    mtoon: { outlineScale: m.outlineScale, shadingToony: m.shadingToony, shadingShift: m.shadingShift, rimLift: m.rimLift },
  };
}

const Proposal = z.object({
  change: z.boolean(),
  rationale: z.string().describe("モデルの評価と、何をなぜ変えるか。運営者向けに日本語で2〜3文"),
  eyeHue: z.number().describe("瞳の色相（0〜360）。変えないなら -1"),
  eyeSaturation: z.number().describe("瞳の彩度の倍率。1 で変えない"),
  eyeLightness: z.number().describe("瞳の明るさの増減。0 で変えない"),
  outlineScale: z.number().describe("輪郭線の太さの倍率。1 で変えない"),
  shadingToony: z.number().describe("影の境目のくっきり具合 0〜1"),
  shadingShift: z.number().describe("影の出やすさ -0.5〜0.3"),
  rimLift: z.number().describe("縁の明るさ 0〜0.3"),
  modelSuggestions: z.array(z.string()).describe("調整値では直せず、モデルの形そのもの（目の形、顔の輪郭など）の修正が必要な点。無ければ空"),
});

/**
 * モデルの改善（瞳の色、輪郭線、陰影の付き方）。撮影した顔を AI が見て調整し、VRM を作り直す。
 * 形そのものの修正が必要な点は onSuggestions に渡し、制作の依頼に回す。
 */
export function modelDomain(opts: {
  initial: ModelParams;
  capture: () => Promise<CaptureImage[]>;
  apply: (m: ModelParams) => Promise<void> | void;
  onSuggestions: (items: string[]) => void;
}): Domain<ModelParams> {
  return {
    id: "model",
    label: "モデル",
    initial: opts.initial,
    minMinutes: 90,
    cooldownMinutes: 300,
    async propose({ current, stats }) {
      const out = await askJson({
        schema: Proposal,
        system: "あなたは VRM モデルを仕上げる 3D アーティストです。トゥーン調（MToon）の陰影・輪郭線・瞳の色を、画像と視聴者の反応を見て少しずつ改善します。",
        content: [
          ...imageBlocks(await opts.capture()),
          {
            type: "text",
            text: [`いまの調整値（版${current.version}）:`, JSON.stringify(current.value, null, 2), "", "版ごとの視聴者の反応:", stats].join("\n"),
          },
        ],
      });
      if (out.modelSuggestions.length) opts.onSuggestions(out.modelSuggestions);
      if (!out.change) return null;
      return {
        rationale: out.rationale,
        value: {
          eye: { ...(out.eyeHue >= 0 ? { hue: out.eyeHue } : {}), saturation: out.eyeSaturation, lightness: out.eyeLightness },
          outlineScale: out.outlineScale,
          shadingToony: out.shadingToony,
          shadingShift: out.shadingShift,
          rimLift: out.rimLift,
        },
      };
    },
    sanitize(prev, next) {
      const hue = next.eye.hue === undefined ? prev.eye.hue : clamp(next.eye.hue, 0, 360);
      return {
        eye: {
          ...(hue === undefined ? {} : { hue: Math.round(hue) }),
          saturation: step(prev.eye.saturation, next.eye.saturation, 0.2, 0.5, 1.6),
          lightness: step(prev.eye.lightness, next.eye.lightness, 0.08, -0.25, 0.25),
        },
        outlineScale: step(prev.outlineScale, next.outlineScale, 0.25, 0.3, 2),
        shadingToony: step(prev.shadingToony, next.shadingToony, 0.1, 0.5, 1),
        shadingShift: step(prev.shadingShift, next.shadingShift, 0.1, -0.5, 0.3),
        rimLift: step(prev.rimLift, next.rimLift, 0.08, 0, 0.3),
      };
    },
    apply: opts.apply,
  };
}
