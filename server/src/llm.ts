import Anthropic from "@anthropic-ai/sdk";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 会話の記憶を持ち、コメントへの返事をストリーミングで返す。
 * 履歴には読み上げた文字列だけを残し、古いやり取りから捨てていく。
 */
export class Brain {
  private client = new Anthropic();
  private history: Anthropic.MessageParam[] = [];

  constructor(
    private system: string,
    private model: string,
    private effort: Effort,
    private maxHistory = 20,
  ) {}

  /** 性格の改善などでシステムプロンプトが変わったとき */
  setSystem(system: string) {
    this.system = system;
  }

  async *respond(userContent: string, signal: AbortSignal): AsyncGenerator<string> {
    const messages: Anthropic.MessageParam[] = [...this.history, { role: "user", content: userContent }];
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 2048,
        system: this.system,
        messages,
        output_config: { effort: this.effort },
        // 安全上の理由で断られたとき、サーバー側で別モデルに切り替えて答えさせる
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      } as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
      { signal },
    );

    let spoken = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        spoken += event.delta.text;
        yield event.delta.text;
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      throw new Error(`refusal: ${final.stop_details?.category ?? "unknown"}`);
    }
    this.remember(userContent, spoken);
  }

  /** 途中で止めた返事も、言ったところまでは覚えておく。 */
  remember(userContent: string, spoken: string) {
    if (!spoken.trim()) return;
    this.history.push({ role: "user", content: userContent }, { role: "assistant", content: spoken });
    while (this.history.length > this.maxHistory) this.history.splice(0, 2);
  }
}
