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

export const FACE_EXPRESSIONS = ["happy", "relaxed", "angry", "sad", "surprised"] as const;
export type FaceExpression = (typeof FACE_EXPRESSIONS)[number];

/** 衣装と髪型の組み合わせ1つ分。VRM ファイル1つに対応する。 */
export interface Look {
  id: string;
  name: string;
  /** avatar/public からのパス */
  file: string;
  outfit: string;
  hair: string;
  tags: string[];
}

/** 顔の見せ方の調整値。AI のレビューで少しずつ更新され、版ごとに履歴が残る。 */
export interface FaceParams {
  version: number;
  emotions: Record<Emotion, Partial<Record<FaceExpression, number>>>;
  /** 口の開き具合の倍率 */
  mouthGain: number;
  /** まばたきの間隔（秒） */
  blinkMin: number;
  blinkMax: number;
  /** 視線のゆらぎの大きさ */
  gazeJitter: number;
  note: string;
}

export interface CaptureImage {
  emotion: Emotion;
  /** PNG を base64 にしたもの */
  png: string;
}

export type ServerToAvatar =
  | SpeakMessage
  | { type: "stop" }
  | { type: "pose"; gesture: Gesture }
  | { type: "look"; look: Look }
  | { type: "face"; params: FaceParams }
  | { type: "capture"; requestId: string };

export type AvatarToServer =
  | { type: "capture-result"; requestId: string; images: CaptureImage[] }
  | { type: "look-failed"; lookId: string; error: string };

export type AdminToServer =
  | { type: "comment"; author: string; text: string }
  | { type: "say"; text: string }
  | { type: "stop" }
  | { type: "gesture"; gesture: Gesture }
  | { type: "scene"; scene: string }
  | { type: "restyle" }
  | { type: "wear"; lookId: string }
  | { type: "face-review" }
  | { type: "face-rollback" };

export interface AdminState {
  type: "state";
  scene: string;
  scenes: string[];
  look: Look;
  looks: (Look & { available: boolean })[];
  faceVersion: number;
}

export type ServerToAdmin =
  | {
      type: "log";
      level: "info" | "warn" | "error";
      at: string;
      message: string;
    }
  | AdminState;
