import type { AnyToolDefinition } from "../types";
import { searchProtocolsTool } from "./search-protocols";
import { getProtocolMetadataTool } from "./get-protocol-metadata";
import { getChainStatusTool } from "./get-chain-status";
import { getTransactionsTool } from "./get-transactions";
import { getWalletActivityTool } from "./get-wallet-activity";
import { getContractInfoTool } from "./get-contract-info";
import { generateResearchReportTool } from "./generate-research-report";

export const chainProtocolTools: AnyToolDefinition[] = [
  searchProtocolsTool,
  getProtocolMetadataTool,
  getChainStatusTool,
  getTransactionsTool,
  getWalletActivityTool,
  getContractInfoTool,
  generateResearchReportTool,
];

export { REPORT_TOOL_NAME } from "./generate-research-report";
export {
  searchProtocolsTool,
  getProtocolMetadataTool,
  getChainStatusTool,
  getTransactionsTool,
  getWalletActivityTool,
  getContractInfoTool,
  generateResearchReportTool,
};
