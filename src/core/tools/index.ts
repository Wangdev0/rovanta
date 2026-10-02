import { ToolRegistry } from "./registry";
import { marketTools } from "./market";
import { chainProtocolTools } from "./chain-protocol";
import type { AnyToolDefinition } from "./types";

export const ALL_TOOLS: AnyToolDefinition[] = [...marketTools, ...chainProtocolTools];

export function createDefaultRegistry(extra: AnyToolDefinition[] = []): ToolRegistry {
  return new ToolRegistry([...ALL_TOOLS, ...extra]);
}

export { ToolRegistry } from "./registry";
export { defineTool } from "./define";
export { executeTool } from "./executor";
export type * from "./types";
