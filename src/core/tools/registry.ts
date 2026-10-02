import { z } from "zod";
import type { ToolSpec } from "../llm/types";
import type { AnyToolDefinition } from "./types";

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  constructor(tools: AnyToolDefinition[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AnyToolDefinition): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Tool specs in the provider-neutral format sent to the model. */
  toSpecs(): ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toParameterSchema(tool.input),
    }));
  }
}

export function toParameterSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  if (json.type !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return json;
}
