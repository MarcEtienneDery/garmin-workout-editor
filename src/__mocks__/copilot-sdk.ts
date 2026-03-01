/**
 * Jest manual mock for @github/copilot-sdk
 * Used automatically via moduleNameMapper in jest.config.js
 */

export class CopilotClient {
  start = jest.fn().mockResolvedValue(undefined);
  stop = jest.fn().mockResolvedValue([]);
  createSession = jest.fn().mockResolvedValue({
    on: jest.fn().mockReturnValue(jest.fn()),
    send: jest.fn().mockResolvedValue(undefined),
    sendAndWait: jest.fn().mockResolvedValue({ data: { content: "{}" } }),
    destroy: jest.fn().mockResolvedValue(undefined),
  });
}

export class CopilotSession {}

export function defineTool(tool: any) {
  return tool;
}

export type AssistantMessageEvent = {
  type: "assistant.message";
  data: { content: string };
};
