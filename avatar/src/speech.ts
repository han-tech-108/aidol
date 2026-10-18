import type { SpeakMessage, Vowel } from "../../server/src/protocol.ts";

const FAKE_VOWELS: Vowel[] = ["a", "i", "u", "e", "o", "a", "o"];

/** 発話を順番に再生し、今の口の形と声の大きさを教える。 */
export class SpeechPlayer {
  readonly ctx = new AudioContext();
  private analyser = this.ctx.createAnalyser();
  private levelBuf = new Float32Array(1024);
  private queue: SpeakMessage[] = [];
  private current: { msg: SpeakMessage; start: number; source?: AudioBufferSourceNode } | null = null;
  private busy = false;

  /** 1文の再生が始まったときに呼ばれる（表情・動作の切り替えに使う）。 */
  onStart: (msg: SpeakMessage) => void = () => {};
  onIdle: () => void = () => {};

  constructor() {
    this.analyser.fftSize = 1024;
    this.analyser.connect(this.ctx.destination);
  }

  enqueue(msg: SpeakMessage) {
    this.queue.push(msg);
    void this.next();
  }

  stop() {
    this.queue.length = 0;
    try {
      this.current?.source?.stop();
    } catch {
      /* まだ再生前 */
    }
    this.current = null;
  }

  get speaking() {
    return this.current !== null;
  }

  private async next() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const msg = this.queue.shift()!;
        await this.play(msg);
      }
    } finally {
      this.busy = false;
      this.onIdle();
    }
  }

  private async play(msg: SpeakMessage) {
    let source: AudioBufferSourceNode | undefined;
    let duration = msg.duration;
    if (msg.audio) {
      const bytes = Uint8Array.from(atob(msg.audio), (c) => c.charCodeAt(0));
      const buffer = await this.ctx.decodeAudioData(bytes.buffer);
      source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyser);
      duration = buffer.duration;
    }
    const entry = { msg, start: this.ctx.currentTime, source };
    this.current = entry;
    this.onStart(msg);
    await new Promise<void>((resolve) => {
      if (source) {
        source.onended = () => resolve();
        source.start();
      } else {
        setTimeout(resolve, duration * 1000);
      }
    });
    if (this.current === entry) this.current = null;
    // 文と文のあいだに少し間を置く
    await new Promise((r) => setTimeout(r, 120));
  }

  /** 今出している母音。話していなければ null。 */
  vowel(): Vowel | null {
    const cur = this.current;
    if (!cur) return null;
    const t = this.ctx.currentTime - cur.start;
    const keys = cur.msg.visemes;
    if (!keys?.length) {
      // 音声が無いときは、それらしく口を動かす
      if (t > cur.msg.duration) return null;
      return FAKE_VOWELS[Math.floor(t / 0.12) % FAKE_VOWELS.length]!;
    }
    let v: Vowel = "pau";
    for (const k of keys) {
      if (k.t > t) break;
      v = k.vowel;
    }
    return v;
  }

  /** 声の大きさ（0〜1くらい）。 */
  level(): number {
    if (!this.current?.source) return this.current ? 0.3 : 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const x of this.levelBuf) sum += x * x;
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 6);
  }
}
