export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function jsonResult(body: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}
