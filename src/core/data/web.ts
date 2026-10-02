import { RovantaError } from "@/core/errors";
import type { WebDocument } from "./schemas";
import type { Sourced, WebResearchProvider } from "./types";

export class DisabledWebResearchProvider implements WebResearchProvider {
  readonly id = "web:disabled";
  readonly name = "Web research (not configured)";
  readonly enabled = false;

  async search(): Promise<Sourced<WebDocument[]>> {
    throw new RovantaError("DATA_UNAVAILABLE", "Web research provider is not configured. See README: Data providers.");
  }
}
