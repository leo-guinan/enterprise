/**
 * Extraction Layer
 *
 * Extracts factual observations from conversations using LLM tool calls.
 * Port of finereli/pyramid's llm.py extract_observations.
 */

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

export interface ExtractedObservation {
  text: string;
  timestamp: string;
}

/**
 * LLM-agnostic extraction interface.
 * Callers provide their own LLM function so Pyramid doesn't depend on any specific provider.
 */
export type LLMToolCallFn = (opts: {
  system: string;
  prompt: string;
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, any>;
  }>;
}) => Promise<Array<{ name: string; args: Record<string, any> }>>;

const EXTRACTION_SYSTEM = `You are a memory extraction agent. Extract specific, factual observations from the conversation.

Each observation should be:
- A single factual sentence
- Specific: include names, dates, numbers, places, preferences
- NOT meta-observations ("user discussed X") — capture the actual fact ("User lives in Austin")
- NOT opinions about quality — capture what was said/decided

Call add_observation for each distinct fact you extract.`;

const ADD_OBSERVATION_TOOL = {
  name: 'add_observation',
  description: 'Record a factual observation extracted from the conversation',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Single factual sentence' },
      timestamp: { type: 'string', description: 'ISO timestamp of when this was observed' },
    },
    required: ['text', 'timestamp'],
  },
};

/**
 * Extract observations from a batch of messages.
 */
export async function extractObservations(
  messages: Message[],
  llmFn: LLMToolCallFn,
  defaultTimestamp?: string,
): Promise<ExtractedObservation[]> {
  if (!messages.length) return [];

  const conversationText = messages
    .map((m) => `[${m.timestamp || defaultTimestamp || new Date().toISOString()}] ${m.role}: ${m.content}`)
    .join('\n\n');

  const toolCalls = await llmFn({
    system: EXTRACTION_SYSTEM,
    prompt: `Extract factual observations from this conversation:\n\n${conversationText}`,
    tools: [ADD_OBSERVATION_TOOL],
  });

  return toolCalls
    .filter((tc) => tc.name === 'add_observation')
    .map((tc) => ({
      text: tc.args.text as string,
      timestamp: tc.args.timestamp as string || defaultTimestamp || new Date().toISOString(),
    }));
}
