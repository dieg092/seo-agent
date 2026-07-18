// src/prioritization/stableKey.ts
import { createHash } from "node:crypto";
import type { Finding } from "./types";

export function computeStableKey(finding: Finding): string {
  return createHash("sha256")
    .update(`${finding.source}:${finding.stableKeyInput}`)
    .digest("hex");
}
