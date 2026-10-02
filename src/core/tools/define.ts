import type { z } from "zod";
import type { ToolDefinition } from "./types";

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  if (!TOOL_NAME.test(def.name)) {
    throw new Error(`Invalid tool name "${def.name}": use lowercase snake_case`);
  }
  if (def.description.trim().length < 10) {
    throw new Error(`Tool "${def.name}" needs a meaningful description`);
  }
  return def;
}
