import { generateText, isStepCount, tool, type LanguageModel } from "ai";
import { z } from "zod";

import type { Agent } from "./run.ts";

export interface ModelAgentOptions {
  model: LanguageModel;
  /** The most model calls one run may make. An agent still calling tools at the limit is stopped. */
  maxSteps?: number;
  maxOutputTokens?: number;
}

/**
 * A model attempting the task with the two tools, in a plain loop: the model
 * calls a tool, sees the result, and goes on until it stops calling tools.
 *
 * Nothing about the model is tuned here. Effort, thinking and sampling are
 * left at each provider's defaults, because a default is what most people
 * run. No server-side fallback is requested either: a run answered by a
 * different model would be scored under the wrong name.
 */
export function createModelAgent(options: ModelAgentOptions): Agent {
  const maxSteps = options.maxSteps ?? 40;

  return async (task, tools, signal) => {
    const result = await generateText({
      model: options.model,
      prompt: task,
      abortSignal: signal,
      maxOutputTokens: options.maxOutputTokens ?? 16_000,
      stopWhen: isStepCount(maxSteps),
      tools: {
        http_request: tool({
          description:
            "Make an HTTP request and get back the status and the response body as text. Long bodies are cut. Use it to read documentation and to call APIs.",
          inputSchema: z.object({
            method: z.string().describe("GET, POST, PUT, PATCH or DELETE"),
            url: z.string().describe("The full URL, starting with https://"),
            headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
            body: z.string().optional().describe("The request body, as a string. For JSON, the JSON text."),
          }),
          execute: (input) => tools.http(input),
        }),
        wait: tool({
          description: "Pause for some seconds, up to 30 at a time, for example while an email arrives.",
          inputSchema: z.object({ seconds: z.number().describe("How long to wait") }),
          execute: ({ seconds }) => tools.wait(seconds),
        }),
      },
    });

    const lastStep = result.steps.at(-1);
    return {
      // At the step limit the model was still calling tools; say so rather than report "tool-calls".
      finishReason: result.steps.length >= maxSteps && lastStep?.finishReason === "tool-calls" ? "step-limit" : result.finishReason,
      text: result.text,
      notes: result.steps.map((step) => step.text).filter((text) => text.length > 0),
      steps: result.steps.length,
      usage: { inputTokens: result.totalUsage.inputTokens, outputTokens: result.totalUsage.outputTokens },
    };
  };
}

/** Turns "anthropic:claude-opus-5-5" or "openai:<model id>" into a model. Each provider reads its own key from the environment. */
export async function resolveModel(spec: string): Promise<LanguageModel> {
  const separator = spec.indexOf(":");
  const provider = spec.slice(0, separator);
  const modelId = spec.slice(separator + 1);
  if (separator <= 0 || !modelId) {
    throw new Error(`"${spec}" is not a model. Write it as provider:model, for example anthropic:claude-opus-5-5.`);
  }
  if (provider === "anthropic") {
    return (await import("@ai-sdk/anthropic")).anthropic(modelId);
  }
  if (provider === "openai") {
    return (await import("@ai-sdk/openai")).openai(modelId);
  }
  throw new Error(`Unknown provider "${provider}". Supported: anthropic, openai.`);
}
