import { EMOTIONS, GESTURES, type Emotion, type Gesture } from "./protocol.ts";

export interface ParsedSentence {
  text: string;
  emotion: Emotion | undefined;
  gestures: Gesture[];
}

const TAG = /\[([a-z]+)\]/g;

/** "[joy][wave]こんにちは！" から感情・動作タグを取り出し、読み上げる文だけを残す。 */
export function parseTags(raw: string): ParsedSentence {
  let emotion: Emotion | undefined;
  const gestures: Gesture[] = [];
  const text = raw
    .replace(TAG, (_, name: string) => {
      if ((EMOTIONS as readonly string[]).includes(name)) emotion = name as Emotion;
      else if ((GESTURES as readonly string[]).includes(name)) gestures.push(name as Gesture);
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { text, emotion, gestures };
}

const SENTENCE_END = /[。！？!?♪\n]/;

/**
 * ストリーミングで届く文字列を文ごとに切り出す。
 * push() で文字を足すと、完成した文を返す。最後に flush() で残りを返す。
 */
export class SentenceSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    for (;;) {
      const m = SENTENCE_END.exec(this.buffer);
      if (!m) break;
      // 「！？」のように句読点が続く場合はまとめて1文にする
      let end = m.index + 1;
      while (end < this.buffer.length && SENTENCE_END.test(this.buffer[end]!)) end++;
      // 末尾ちょうどで終わる句読点は、次のチャンクで「！？」と続くかもしれないので待つ
      if (end === this.buffer.length) break;
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }
}
