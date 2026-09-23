import { describe, expect, it, vi } from "vitest";

// GoogleGenAI をモックし、generateContent の挙動をテストごとに差し替える。
// GeminiClassifierClient は ai.models.generateContent(...) の戻り値/reject のみに依存するため、
// GoogleGenAIOptions や認証まわりはモックの外側に置く必要がない。
const generateContent =
  vi.fn<
    (params: {
      model: string;
      contents: string;
      config: { abortSignal?: AbortSignal };
    }) => Promise<{ text: string }>
  >();

vi.mock("@google/genai", () => {
  class GoogleGenAI {
    models = { generateContent };
  }
  return {
    GoogleGenAI,
    Type: { OBJECT: "OBJECT", BOOLEAN: "BOOLEAN", STRING: "STRING" },
  };
});

// vi.mock はモジュールロードより先に評価されるため import は mock 定義の後に置く。
const { GeminiClassifierClient } =
  await import("../../src/classifier/client.js");

function makeClient(timeoutMs?: number) {
  return new GeminiClassifierClient({
    project: "proj",
    location: "us-central1",
    defaultModel: "gemini-x",
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

describe("GeminiClassifierClient", () => {
  it("returns the parsed result for a normal fast response", async () => {
    generateContent.mockImplementation(async () => ({
      text: JSON.stringify({ result: true, reason: "matched" }),
    }));
    const client = makeClient(10_000);
    const result = await client.classify({
      criteria: "trigger on task requests",
      text: "please fix the build",
    });
    expect(result).toEqual({ result: true, reason: "matched" });
  });

  it("throws a timeout error when generateContent hangs past the deadline", async () => {
    // 実 SDK (fetch) は abortSignal の abort をそのまま reject として伝播する
    // (node_modules/@google/genai の apiCall は signal を fetch にそのまま渡す)。
    // この fake もその契約を再現し、呼び出しが返ってこないケースをタイムアウトで
    // 確実に打ち切れることを確認する。
    generateContent.mockImplementation(
      (params) =>
        new Promise<{ text: string }>((_resolve, reject) => {
          params.config.abortSignal?.addEventListener("abort", () => {
            reject(
              new DOMException("This operation was aborted", "AbortError"),
            );
          });
        }),
    );
    const client = makeClient(20);
    await expect(client.classify({ criteria: "c", text: "t" })).rejects.toThrow(
      /^classifier: timed out after 20ms/,
    );
  });

  it("uses the default 10s timeout when timeoutMs is not specified", async () => {
    generateContent.mockImplementation(async () => ({
      text: JSON.stringify({ result: false, reason: "ok" }),
    }));
    const client = makeClient();
    await expect(
      client.classify({ criteria: "c", text: "t" }),
    ).resolves.toEqual({ result: false, reason: "ok" });
  });
});
