import { z } from "zod";
import { askJson } from "../../ai.ts";
import type { Domain } from "../engine.ts";
import type { VoiceParams, VoiceStyle } from "../../tts.ts";
import { step } from "./bounds.ts";

const Proposal = z.object({
  change: z.boolean(),
  rationale: z.string().describe("何をなぜ変えるか。運営者向けに日本語で1〜2文"),
  speaker: z.number().describe("話者スタイルの id。一覧にあるものだけ"),
  speedScale: z.number(),
  pitchScale: z.number(),
  intonationScale: z.number(),
  volumeScale: z.number(),
  pauseLengthScale: z.number(),
});

export const DEFAULT_VOICE: Omit<VoiceParams, "speaker"> = {
  speedScale: 1.05,
  pitchScale: 0,
  intonationScale: 1.15,
  volumeScale: 1,
  pauseLengthScale: 1,
};

/** 声（話者・速さ・高さ・抑揚など）。 */
export function voiceDomain(opts: { initial: VoiceParams; styles: () => Promise<VoiceStyle[]>; apply: (v: VoiceParams) => void }): Domain<VoiceParams> {
  let known: VoiceStyle[] = [];
  return {
    id: "voice",
    label: "声",
    initial: opts.initial,
    minMinutes: 60,
    cooldownMinutes: 150,
    async propose({ current, stats, metrics }) {
      known = await opts.styles();
      const voiceTalk = metrics
        .recentComments(200)
        .filter((c) => /声|喋り|しゃべり|滑舌|聞き取|早口|ゆっくり/.test(c.text))
        .map((c) => `- ${c.text}`)
        .join("\n");
      const out = await askJson({
        schema: Proposal,
        effort: "low",
        system:
          "あなたはバーチャルアイドルの音響ディレクターです。VOICEVOX の話者と読み上げパラメータを、視聴者の反応を見ながら少しずつ改善します。" +
          "聞き取りやすさを最優先に、キャラクターに合う声を探します。話者の変更はキャラの印象が大きく変わるので、反応が明らかに悪いときだけにしてください。",
        content: [
          `いまの設定（版${current.version}）: ${JSON.stringify(current.value)}`,
          "",
          "使える話者スタイル:",
          known.length ? known.map((s) => `- ${s.id}: ${s.name}`).join("\n") : "（取得できませんでした。話者は変えないでください）",
          "",
          "版ごとの視聴者の反応:",
          stats,
          "",
          "声についての最近のコメント:",
          voiceTalk || "（なし）",
        ].join("\n"),
      });
      if (!out.change) return null;
      const { change: _c, rationale, ...value } = out;
      return { value, rationale };
    },
    sanitize(prev, next) {
      return {
        speaker: known.some((s) => s.id === next.speaker) ? next.speaker : prev.speaker,
        speedScale: step(prev.speedScale, next.speedScale, 0.08, 0.85, 1.3),
        pitchScale: step(prev.pitchScale, next.pitchScale, 0.03, -0.12, 0.12),
        intonationScale: step(prev.intonationScale, next.intonationScale, 0.15, 0.7, 1.7),
        volumeScale: step(prev.volumeScale, next.volumeScale, 0.1, 0.7, 1.4),
        pauseLengthScale: step(prev.pauseLengthScale, next.pauseLengthScale, 0.15, 0.6, 1.5),
      };
    },
    apply: opts.apply,
  };
}
