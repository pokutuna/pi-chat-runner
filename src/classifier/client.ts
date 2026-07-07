// ClassifierClient — session-model.md §5 Layer 2 (LLM classifier) の LLM 呼び出し部。
//
// gate (src/gate/gates/classifier.ts) から criteria + 対象メッセージを渡し、
// {result: boolean, reason: string} を得る薄いトランスポート。gate/bridge/runner が
// LLM SDK に直接依存しないよう、この境界にまとめる (src/gate/gates/ には置かない)。
//
// 実装は Vertex AI + ADC (pi の google-vertex と同じ認証)。project/location は
// bridge から注入する。モデルは既定 (defaultModel) を per-call で上書きできる
// (per-gate model 切替のため。plan「モデル切り替えの経路」参照)。

import { GoogleGenAI, type Schema, Type } from "@google/genai";

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

/** 構造化出力スキーマ (plan 要件 2: 当面固定)。responseSchema は Google の Schema 型。 */
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

/** 型ガード: SDK の JSON.parse 結果が期待形かを確認する (要件 2 の shape を実行時保証)。 */
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

	constructor(opts: {
		project: string;
		location: string;
		defaultModel: string;
	}) {
		// vertexai: true + project/location で ADC を使う (API キー不要)。
		this.ai = new GoogleGenAI({
			vertexai: true,
			project: opts.project,
			location: opts.location,
		});
		this.defaultModel = opts.defaultModel;
	}

	async classify(input: {
		criteria: string;
		text: string;
		model?: string;
	}): Promise<ClassificationResult> {
		const model = input.model ?? this.defaultModel;
		const response = await this.ai.models.generateContent({
			model,
			contents: buildPrompt(input.criteria, input.text),
			config: {
				temperature: 0,
				responseMimeType: "application/json",
				responseSchema: RESPONSE_SCHEMA,
			},
		});

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
