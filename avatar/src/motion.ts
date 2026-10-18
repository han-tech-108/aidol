import * as THREE from "three";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import { FACE_EXPRESSIONS, type Emotion, type FaceParams, type Gesture, type MotionParams, type Vowel } from "../../server/src/protocol.ts";

type Pose = Partial<Record<VRMHumanBoneName, [number, number, number]>>;

/** 腕を下ろした基本姿勢（VRM の正規化ボーンは T ポーズが原点）。 */
const BASE: Pose = {
  leftUpperArm: [0, 0, -1.25],
  rightUpperArm: [0, 0, 1.25],
  leftLowerArm: [0, -0.15, 0],
  rightLowerArm: [0, 0.15, 0],
};

interface GestureDef {
  duration: number;
  /** p: 0〜1 の進み具合、t: 経過秒。基本姿勢への上乗せを返す。 */
  pose: (p: number, t: number) => Pose;
}

const GESTURES: Record<Gesture, GestureDef> = {
  wave: {
    duration: 2.2,
    pose: (_p, t) => ({
      rightUpperArm: [0, 0.2, -0.9],
      rightLowerArm: [0, 0, -1.7 + 0.3 * Math.sin(t * 9)],
      head: [0, 0, 0.06],
    }),
  },
  nod: { duration: 1.0, pose: (p) => ({ head: [0.2 * Math.abs(Math.sin(p * Math.PI * 2)), 0, 0], neck: [0.05, 0, 0] }) },
  shake: { duration: 1.2, pose: (p) => ({ head: [0, 0.25 * Math.sin(p * Math.PI * 6), 0] }) },
  think: {
    duration: 2.6,
    pose: () => ({
      head: [-0.05, 0.08, 0.16],
      rightUpperArm: [0, 0.9, -0.5],
      rightLowerArm: [0, 2.3, 0],
    }),
  },
  bow: { duration: 2.0, pose: (p) => ({ spine: [0.4 * Math.sin(p * Math.PI), 0, 0], chest: [0.15 * Math.sin(p * Math.PI), 0, 0], head: [0.1, 0, 0] }) },
  cheer: {
    duration: 1.8,
    pose: (_p, t) => ({
      leftUpperArm: [0, 0, 2.0 + 0.12 * Math.sin(t * 12)],
      rightUpperArm: [0, 0, -2.0 - 0.12 * Math.sin(t * 12)],
      spine: [-0.06, 0, 0],
      head: [-0.08, 0, 0],
    }),
  },
};

/** サーバーから顔の調整値が届くまでの初期値（config/face.json と同じ）。 */
export const DEFAULT_FACE: FaceParams = {
  emotions: {
    neutral: {},
    joy: { happy: 0.75 },
    fun: { relaxed: 0.7 },
    angry: { angry: 0.7 },
    sorrow: { sad: 0.7 },
    surprised: { surprised: 0.8 },
  },
  mouthGain: 1,
  blinkMin: 1.5,
  blinkMax: 6,
  gazeJitter: 0.25,
};

/** 体の動きの調整値（AI が配信の反応を見て少しずつ変える） */
export const DEFAULT_MOTION: MotionParams = { gestureScale: 1, gestureSpeed: 1, idleScale: 1, speakingNod: 1 };

const VOWEL_EXPRESSIONS: Record<Vowel, Record<string, number>> = {
  a: { aa: 0.9 },
  i: { ih: 0.8 },
  u: { ou: 0.8 },
  e: { ee: 0.8 },
  o: { oh: 0.85 },
  N: { ou: 0.15 },
  pau: {},
};
const MOUTH_KEYS = ["aa", "ih", "ou", "ee", "oh"];

const smooth = (x: number) => x * x * (3 - 2 * x);
const approach = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** 待機・身振り・表情・口パク・まばたき・視線をまとめて毎フレーム動かす。 */
export class Performer {
  private time = 0;
  private active: { def: GestureDef; started: number }[] = [];
  private emotion: Emotion = "neutral";
  private weights = new Map<string, number>();
  private nextBlink = 2;
  private blinkStart = -1;
  private gaze = new THREE.Object3D();
  private gazeOffset = new THREE.Vector3();
  private nextSaccade = 0;

  constructor(
    readonly vrm: VRM,
    private camera: THREE.Camera,
    public face: FaceParams = DEFAULT_FACE,
    public motion: MotionParams = DEFAULT_MOTION,
  ) {
    if (vrm.lookAt) vrm.lookAt.target = this.gaze;
  }

  get currentEmotion() {
    return this.emotion;
  }

  gesture(g: Gesture) {
    const def = GESTURES[g];
    const speed = this.motion.gestureSpeed;
    // 速さを変えるときは、身振りの時間を縮めて同じ動きを速く再生する
    this.active.push({ def: { duration: def.duration / speed, pose: (p, e) => def.pose(p, e * speed) }, started: this.time });
  }

  setEmotion(e: Emotion) {
    this.emotion = e;
  }

  update(dt: number, vowel: Vowel | null, level: number) {
    this.time += dt;
    const t = this.time;
    this.updateBones(t, level);
    this.updateFace(dt, t, vowel);
    this.updateGaze(t);
    this.vrm.update(dt);
  }

  private updateBones(t: number, level: number) {
    const { idleScale: k, speakingNod, gestureScale } = this.motion;
    const breath = Math.sin(t * 1.6) * k;
    const pose: Pose = {
      hips: [0, 0.04 * k * Math.sin(t * 0.5), 0.015 * k * Math.sin(t * 0.37)],
      spine: [0.015 * breath, 0, 0.02 * k * Math.sin(t * 0.37 + 1)],
      chest: [0.015 * breath, 0, 0],
      neck: [0, 0, 0],
      head: [0.03 * k * Math.sin(t * 0.7) + 0.06 * speakingNod * level, 0.07 * k * Math.sin(t * 0.29), 0.025 * k * Math.sin(t * 0.53)],
      leftUpperArm: [0, 0, -0.03 * breath],
      rightUpperArm: [0, 0, 0.03 * breath],
    };
    for (const [bone, r] of Object.entries(BASE) as [VRMHumanBoneName, [number, number, number]][]) add(pose, bone, r, 1);

    this.active = this.active.filter((g) => t - g.started < g.def.duration);
    for (const g of this.active) {
      const elapsed = t - g.started;
      const p = elapsed / g.def.duration;
      const env = smooth(Math.min(1, elapsed / 0.25, (g.def.duration - elapsed) / 0.35));
      for (const [bone, r] of Object.entries(g.def.pose(p, elapsed)) as [VRMHumanBoneName, [number, number, number]][]) {
        add(pose, bone, r, env * gestureScale);
      }
    }

    for (const [bone, r] of Object.entries(pose) as [VRMHumanBoneName, [number, number, number]][]) {
      this.vrm.humanoid.getNormalizedBoneNode(bone)?.rotation.set(r[0], r[1], r[2]);
    }
  }

  private updateFace(dt: number, t: number, vowel: Vowel | null) {
    const em = this.vrm.expressionManager;
    if (!em) return;
    const target = this.face.emotions[this.emotion] ?? {};
    for (const k of FACE_EXPRESSIONS) this.set(em, k, approach(this.weights.get(k) ?? 0, target[k] ?? 0, 6, dt));

    const mouth = vowel ? VOWEL_EXPRESSIONS[vowel] : {};
    const gain = this.face.mouthGain;
    for (const k of MOUTH_KEYS) this.set(em, k, approach(this.weights.get(k) ?? 0, Math.min(1, (mouth[k] ?? 0) * gain), 22, dt));

    // 笑顔で目を細めているときはまばたきしない
    if (t > this.nextBlink && this.blinkStart < 0) this.blinkStart = t;
    let blink = 0;
    if (this.blinkStart >= 0) {
      const b = (t - this.blinkStart) / 0.16;
      blink = b < 1 ? Math.sin(b * Math.PI) : 0;
      if (b >= 1) {
        this.blinkStart = -1;
        this.nextBlink = t + this.face.blinkMin + Math.random() * (this.face.blinkMax - this.face.blinkMin);
      }
    }
    this.set(em, "blink", blink * (1 - (this.weights.get("happy") ?? 0)));
  }

  private set(em: NonNullable<VRM["expressionManager"]>, key: string, value: number) {
    this.weights.set(key, value);
    em.setValue(key, value);
  }

  private updateGaze(t: number) {
    // カメラを見つつ、ときどき視線を少しだけずらす
    if (t > this.nextSaccade) {
      const j = this.face.gazeJitter;
      this.gazeOffset.set((Math.random() - 0.5) * j, (Math.random() - 0.5) * j * 0.5, 0);
      this.nextSaccade = t + 0.8 + Math.random() * 2.5;
    }
    this.camera.getWorldPosition(this.gaze.position);
    this.gaze.position.add(this.gazeOffset);
  }
}

function add(pose: Pose, bone: VRMHumanBoneName, r: [number, number, number], w: number) {
  const cur = pose[bone] ?? [0, 0, 0];
  pose[bone] = [cur[0] + r[0] * w, cur[1] + r[1] * w, cur[2] + r[2] * w];
}
