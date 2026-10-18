import type { VisemeKey, Vowel } from "./protocol.ts";

export interface Speech {
  wav: Buffer;
  visemes: VisemeKey[];
  duration: number;
}

interface Mora {
  consonant_length: number | null;
  vowel: string;
  vowel_length: number;
}
interface AccentPhrase {
  moras: Mora[];
  pause_mora: Mora | null;
}
interface AudioQuery {
  accent_phrases: AccentPhrase[];
  speedScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
}

const VOWELS = new Set(["a", "i", "u", "e", "o", "N"]);

/** VOICEVOX の audio_query から、口の形のタイムラインを作る。 */
export function visemesFromQuery(q: AudioQuery): { visemes: VisemeKey[]; duration: number } {
  const speed = q.speedScale || 1;
  const visemes: VisemeKey[] = [];
  let t = q.prePhonemeLength / speed;
  const add = (m: Mora) => {
    t += (m.consonant_length ?? 0) / speed;
    const v = m.vowel.toLowerCase() === "n" ? "N" : m.vowel.toLowerCase();
    visemes.push({ t, vowel: (VOWELS.has(v) ? v : "pau") as Vowel });
    t += m.vowel_length / speed;
  };
  for (const ap of q.accent_phrases) {
    ap.moras.forEach(add);
    if (ap.pause_mora) add(ap.pause_mora);
  }
  visemes.push({ t, vowel: "pau" });
  return { visemes, duration: t + q.postPhonemeLength / speed };
}

/** 声の調整値。AI が少しずつ改善する。 */
export interface VoiceParams {
  /** VOICEVOX の話者スタイル id */
  speaker: number;
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
  pauseLengthScale: number;
}

export interface VoiceStyle {
  id: number;
  name: string;
}

export class VoicevoxClient {
  params: VoiceParams;

  constructor(
    private baseUrl: string,
    params: VoiceParams,
  ) {
    this.params = params;
  }

  /** 使える話者スタイルの一覧 */
  async styles(): Promise<VoiceStyle[]> {
    try {
      const res = await fetch(`${this.baseUrl}/speakers`, { signal: AbortSignal.timeout(5000) });
      const speakers = (await res.json()) as { name: string; styles: { name: string; id: number }[] }[];
      return speakers.flatMap((sp) => sp.styles.map((st) => ({ id: st.id, name: `${sp.name}（${st.name}）` })));
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/version`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async synthesize(text: string): Promise<Speech> {
    const { speaker, ...scales } = this.params;
    const qs = `text=${encodeURIComponent(text)}&speaker=${speaker}`;
    const qRes = await fetch(`${this.baseUrl}/audio_query?${qs}`, { method: "POST" });
    if (!qRes.ok) throw new Error(`audio_query failed: ${qRes.status}`);
    const query = { ...((await qRes.json()) as AudioQuery), ...scales };

    const sRes = await fetch(`${this.baseUrl}/synthesis?speaker=${speaker}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    });
    if (!sRes.ok) throw new Error(`synthesis failed: ${sRes.status}`);
    const wav = Buffer.from(await sRes.arrayBuffer());
    return { wav, ...visemesFromQuery(query) };
  }
}
