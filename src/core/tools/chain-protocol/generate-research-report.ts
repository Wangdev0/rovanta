import { z } from "zod";
import { defineTool } from "../define";

export const REPORT_TOOL_NAME = "generate_research_report";

export const generateResearchReportTool = defineTool({
  name: REPORT_TOOL_NAME,
  description:
    "Call this once, after gathering evidence with other tools, to signal that ROVANTA should compile the structured research report. Do not call other tools after this. The report is research only, not investment advice or a trading signal; unknown values stay null.",
  category: "analysis",
  activityLabel: "Building research report",
  input: z.object({
    subject: z.string().trim().min(1).max(200).describe("What the report is about, e.g. a token, protocol or wallet"),
    focus: z
      .array(z.string().trim().min(1).max(100))
      .max(8)
      .optional()
      .describe("Optional report sections to emphasize, e.g. [\"liquidity\", \"contract risk\"]"),
  }),
  output: z.object({
    ready: z.literal(true),
    subject: z.string(),
    focus: z.array(z.string()),
  }),
  async run(input) {
    return { data: { ready: true as const, subject: input.subject, focus: input.focus ?? [] }, sources: [] };
  },
  summarize(output) {
    return `Report ready to compile: ${output.subject}`;
  },
});
