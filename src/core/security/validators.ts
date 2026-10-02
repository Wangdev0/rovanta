import { z } from "zod";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH = /^0x[a-fA-F0-9]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-_.]{0,127}$/i;

export function isEvmAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && EVM_ADDRESS.test(value);
}

export function isTxHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && TX_HASH.test(value);
}

export const EvmAddressSchema = z
  .string()
  .trim()
  .regex(EVM_ADDRESS, "Must be a 0x-prefixed 20-byte hex address");

export const TxHashSchema = z.string().trim().regex(TX_HASH, "Must be a 0x-prefixed 32-byte hex hash");

export const SlugSchema = z.string().trim().regex(SLUG, "Must be an identifier without spaces or special characters");

export const ChainSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{1,32}$/, "Must be a chain slug such as \"robinhood\" or \"ethereum\"");

export const SearchQuerySchema = z.string().trim().min(1).max(120);
