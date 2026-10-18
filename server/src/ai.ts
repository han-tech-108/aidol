import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

const client = new Anthropic();
export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

/** 構造化出力で Claude に判断させる共通ヘルパー。 */
export async function askJson<S extends z.ZodType>(opts: {
  schema: S;
  system: string;
  content: string | Anthropic.ContentBlockParam[];
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}): Promise<z.infer<S>> {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 8192,
    output_config: { effort: opts.effort ?? "medium", format: zodOutputFormat(opts.schema) },
    system: opts.system,
    messages: [{ role: "user", content: opts.content }],
  });
  if (response.stop_reason === "refusal") throw new Error(`refusal: ${response.stop_details?.category ?? "unknown"}`);
  if (response.parsed_output == null) throw new Error("AI の出力を読み取れませんでした");
  return response.parsed_output as z.infer<S>;
}
