// サーバー・アバター・管理画面のあいだで WebSocket に流す JSON メッセージの型。
// 描画エンジンを Unity などに替える場合も、この形さえ守ればサーバー側はそのまま使える。

export const EMOTIONS = ["neutral", "joy", "fun", "angry", "sorrow", "surprised"] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const GESTURES = ["wave", "nod", "think", "bow", "cheer", "shake"] as const;
export type Gesture = (typeof GESTURES)[number];

export type Vowel = "a" | "i" | "u" | "e" | "o" | "N" | "pau";

/** 口の形のタイムライン。t は音声の先頭からの秒数。 */
export interface VisemeKey {
  t: number;
  vowel: Vowel;
}

export interface Comment {
  source: "youtube" | "tiktok" | "admin";
  author: string;
  text: string;
}

/** アバターに1文ずつ送る発話。 */
export interface SpeakMessage {
  type: "speak";
  turnId: string;
  index: number;
  text: string;
  emotion: Emotion;
  gestures: Gesture[];
  /** wav を base64 にしたもの。TTS が使えないときは無い。 */
  audio?: string;
  visemes?: VisemeKey[];
  /** 音声が無いとき、口パクを続ける秒数の目安。 */
  duration: number;
}

export type ServerToAvatar = SpeakMessage | { type: "stop" } | { type: "pose"; gesture: Gesture };

export type AdminToServer =
  | { type: "comment"; author: string; text: string }
  | { type: "say"; text: string }
  | { type: "stop" }
  | { type: "gesture"; gesture: Gesture };

export type ServerToAdmin = {
  type: "log";
  level: "info" | "warn" | "error";
  at: string;
  message: string;
};
