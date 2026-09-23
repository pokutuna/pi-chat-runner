// ClassifierClient — config.md §4.1 の `kind: classifier` Gate の LLM 呼び出し部。
//
// gate (src/gate/gates/classifier.ts) から criteria + 対象メッセージを渡し、
// {result: boolean, reason: string} を得る薄いトランスポート。gate / Runner が
// LLM SDK に直接依存しないよう、この境界にまとめる (src/gate/gates/ には置かない)。
//
// 実装は Vertex AI + ADC (pi の google-vertex と同じ認証)。project/location は
// Runner (src/runner.ts) から注入する。モデルは既定 (defaultModel) を per-call で上書きできる
// (per-gate の model 切替のため)。

import { GoogleGenAI, type Schema, Type } from "@google/genai";

// Vertex AI 呼び出しが無応答のまま Gate 判定をブロックしないためのデフォルト上限。
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ClassificationResult {
  result: boolean;
  reason: string;
}

export interface ClassifierClient {
  /** criteria に照らして text を判定する。model 未指定なら実装の既定モデルを使う。 */
  classify(input: {
    criteria: string;
    text: string;
    model?: string;
  }): Promise<ClassificationResult>;
}

/** 構造化出力スキーマ。responseSchema は Google の Schema 型。 */
const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    result: {
      type: Type.BOOLEAN,
      description:
        "true if the message satisfies the criteria (should trigger)",
    },
    reason: {
      type: Type.STRING,
      description: "short justification for the decision",
    },
  },
  required: ["result", "reason"],
};

function buildPrompt(criteria: string, text: string): string {
  return [
    "You are a gate that decides whether a chat message should trigger an agent session.",
    "",
    "Criteria (trigger when this is satisfied):",
    criteria,
    "",
    "Message:",
    text,
    "",
    "Decide whether the message satisfies the criteria. Set result=true to trigger, false otherwise, with a short reason.",
  ].join("\n");
}

/** 型ガード: SDK の JSON.parse 結果が期待形かを実行時に確認する。 */
function isClassificationResult(value: unknown): value is ClassificationResult {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.result === "boolean" && typeof obj.reason === "string";
}

/** Vertex AI (ADC) 経由の Gemini 実装。パース/検証失敗・API エラーは throw し、
 * gate 側で fail-closed に倒す (gate が呼び出し側の副作用を持つ設計: gate.ts コメント)。 */
export class GeminiClassifierClient implements ClassifierClient {
  private readonly ai: GoogleGenAI;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;

  constructor(opts: {
    project: string;
    location: string;
    defaultModel: string;
    timeoutMs?: number;
  }) {
    // vertexai: true + project/location で ADC を使う (API キー不要)。
    this.ai = new GoogleGenAI({
      vertexai: true,
      project: opts.project,
      location: opts.location,
    });
    this.defaultModel = opts.defaultModel;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async classify(input: {
    criteria: string;
    text: string;
    model?: string;
  }): Promise<ClassificationResult> {
    const model = input.model ?? this.defaultModel;
    // @google/genai は abortSignal を自前の AbortController に中継するだけで、
    // fetch が投げる abort 由来のエラーは reason を保持しない (undici は AbortError
    // に丸める)。timeout かどうかは自前の signal.aborted で判定する。
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    let response;
    try {
      response = await this.ai.models.generateContent({
        model,
        contents: buildPrompt(input.criteria, input.text),
        config: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          abortSignal: timeoutSignal,
        },
      });
    } catch (err) {
      if (timeoutSignal.aborted) {
        throw new Error(`classifier: timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    }

    const text = response.text;
    if (text === undefined) {
      throw new Error("classifier: empty response from model");
    }
    const parsed: unknown = JSON.parse(text);
    if (!isClassificationResult(parsed)) {
      throw new Error(
        `classifier: response did not match {result, reason}: ${text}`,
      );
    }
    return parsed;
  }
}
