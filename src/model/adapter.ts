/**
 * ModelAdapter interface for model-assisted grading.
 *
 * Graders (rubric, pairwise) use ModelAdapter to query a judge model
 * without depending on the concrete implementation. This allows the
 * adapter to be backed by a real LLM API, a fake for testing, or
 * a replay cache.
 */

export type CompletionRequest = {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
};

export type CompletionResponse = {
  text: string;
  modelId: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

/**
 * Abstract interface for model completion.
 * Implementations may wrap an LLM API, a test fake, or a replay cache.
 */
export interface ModelAdapter {
  /** Send a completion request and return the response. */
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
