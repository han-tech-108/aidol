import { z } from "zod";
import { askJson } from "../../ai.ts";
import type { Domain } from "../engine.ts";
import type { MotionParams } from "../../protocol.ts";
import { step } from "./bounds.ts";

export const DEFAULT_MOTION: MotionParams = { gestureScale: 1, gestureSpeed: 1, idleScale: 1, speakingNod: 1 };

const Proposal = z.object({
  change: z.boolean(),
  rationale: z.string().describe("何をなぜ変えるか。運営者向けに日本語で1〜2文"),
  gestureScale: z.number(),
  gestureSpeed: z.number(),
  idleScale: z.number(),
  speakingNod: z.number(),
});

/** 体の動き（身振りの大きさ・速さ、待機中の揺れ、喋るときのうなずき）。 */
export function motionDomain(opts: { initial: MotionParams; apply: (m: MotionParams) => void }): Domain<MotionParams> {
  return {
    id: "motion",
    label: "動き",
    initial: opts.initial,
    minMinutes: 45,
    cooldownMinutes: 120,
    async propose({ current, stats, metrics }) {
      const talk = metrics
        .recentComments(200)
        .filter((c) => /動き|ダンス|手|仕草|しぐさ|揺れ|ゆれ|かくかく|カクカク|固い|かたい/.test(c.text))
        .map((c) => `- ${c.text}`)
        .join("\n");
      const out = await askJson({
        schema: Proposal,
        effort: "low",
        system: "あなたはバーチャルアイドルのモーションディレクターです。身振りと待機中の動きの調整値を、視聴者の反応を見ながら少しずつ改善します。いずれも 1 が標準です。",
        content: [`いまの設定（版${current.version}）: ${JSON.stringify(current.value)}`, "", "版ごとの視聴者の反応:", stats, "", "動きについての最近のコメント:", talk || "（なし）"].join("\n"),
      });
      if (!out.change) return null;
      const { change: _c, rationale, ...value } = out;
      return { value, rationale };
    },
    sanitize(prev, next) {
      return {
        gestureScale: step(prev.gestureScale, next.gestureScale, 0.15, 0.5, 1.4),
        gestureSpeed: step(prev.gestureSpeed, next.gestureSpeed, 0.15, 0.6, 1.5),
        idleScale: step(prev.idleScale, next.idleScale, 0.2, 0.3, 1.8),
        speakingNod: step(prev.speakingNod, next.speakingNod, 0.25, 0, 2),
      };
    },
    apply: opts.apply,
  };
}
