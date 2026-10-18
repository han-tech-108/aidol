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

/** VRoid 形式のモデルで色を変えられる部位（マテリアル名で見分ける） */
export const PARTS = ["hair", "tops", "bottoms", "onepiece", "shoes", "accessory", "eye"] as const;
export type Part = (typeof PARTS)[number];

/** 色の変え方。hue を指定すると、その色相に寄せる（元の濃淡の差は保つ）。 */
export interface ColorEdit {
  /** 目標の色相（0〜360）。省略すると色相は変えない */
  hue?: number;
  /** 彩度の倍率（1 で変えない） */
  saturation?: number;
  /** 明るさの増減（-0.5〜0.5、0 で変えない） */
  lightness?: number;
}

/** トゥーン調の陰影・輪郭線の調整（VRM 1.0 の MToon） */
export interface MtoonEdit {
  /** 輪郭線の太さの倍率 */
  outlineScale?: number;
  /** 影の境目のくっきり具合（0〜1） */
  shadingToony?: number;
  /** 影の出やすさ（-1〜1、マイナスで影が減る） */
  shadingShift?: number;
  /** リムライト（縁の明るさ）の強さ（0〜1） */
  rimLift?: number;
}

/** 元の VRM から新しい VRM を作るときの変更内容 */
export interface LookEdits {
  colors?: Partial<Record<Part, ColorEdit>>;
  mtoon?: MtoonEdit;
}

/** 衣装と髪型の組み合わせ1つ分。VRM ファイル1つに対応する。 */
export interface Look {
  id: string;
  name: string;
  /** アバターが読み込むファイル。avatar/public からのパス、または /generated/ で始まるサーバー上のパス */
  file: string;
  outfit: string;
  hair: string;
  tags: string[];
  /** AI が作った見た目なら、元にしたファイルと変更内容 */
  generated?: { source: string; edits: LookEdits; createdAt: string; rationale: string };
  /** 反応が悪く、もう選ばない見た目 */
  retired?: boolean;
}

/** 顔の見せ方の調整値。AI のレビューで少しずつ更新され、版ごとに履歴が残る。 */
export interface FaceParams {
  emotions: Record<Emotion, Partial<Record<FaceExpression, number>>>;
  /** 口の開き具合の倍率 */
  mouthGain: number;
  /** まばたきの間隔（秒） */
  blinkMin: number;
  blinkMax: number;
  /** 視線のゆらぎの大きさ */
  gazeJitter: number;
}

/** 体の動きの調整値 */
export interface MotionParams {
  /** 身振りの大きさの倍率 */
  gestureScale: number;
  /** 身振りの速さの倍率 */
  gestureSpeed: number;
  /** 待機中の揺れ（呼吸・体の揺れ）の大きさ */
  idleScale: number;
  /** 喋るときのうなずきの大きさ */
  speakingNod: number;
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
  | { type: "motion"; params: MotionParams }
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
  | { type: "design" }
  | { type: "evolve"; domain: string }
  | { type: "revert"; domain: string }
  | { type: "freeze"; domain: string; frozen: boolean }
  | { type: "pause-evolution"; paused: boolean };

/** 自己改善エンジンの状態（管理画面に表示） */
export interface EvolutionStatus {
  paused: boolean;
  liveMinutes: number;
  active: { domain: string; baseline: number; candidate: number; startedAtLiveMinute: number } | null;
  domains: { id: string; label: string; version: number; rationale: string; frozen: boolean }[];
}

export interface AdminState {
  type: "state";
  scene: string;
  scenes: string[];
  look: Look;
  looks: (Look & { available: boolean })[];
  evolution: EvolutionStatus;
}

export type ServerToAdmin =
  | {
      type: "log";
      level: "info" | "warn" | "error";
      at: string;
      message: string;
    }
  | AdminState;
