import type { AnyToolDefinition } from "../types";
import { compareAssetsTool } from "./compare-assets";
import { getLiquidityTool } from "./get-liquidity";
import { getMarketDataTool } from "./get-market-data";
import { getTokenMetadataTool } from "./get-token-metadata";
import { getTokenPriceTool } from "./get-token-price";
import { getVolumeTool } from "./get-volume";
import { searchTokensTool } from "./search-tokens";

export const marketTools: AnyToolDefinition[] = [
  searchTokensTool,
  getTokenMetadataTool,
  getTokenPriceTool,
  getMarketDataTool,
  getVolumeTool,
  getLiquidityTool,
  compareAssetsTool,
];

export {
  compareAssetsTool,
  getLiquidityTool,
  getMarketDataTool,
  getTokenMetadataTool,
  getTokenPriceTool,
  getVolumeTool,
  searchTokensTool,
};
export { formatUsd, formatPct } from "./format";
export { TokenInputSchema, TokenInputShape, toTokenRef, type TokenInput } from "./token-input";
