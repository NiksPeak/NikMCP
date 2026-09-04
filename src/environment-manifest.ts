import { readFileSync, statSync } from "node:fs";

const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

export interface ManifestInput {
  manifestPath?: string;
  manifest?: unknown;
}

export function resolveManifestInput(input: ManifestInput): unknown | undefined {
  if (input.manifestPath && input.manifest !== undefined) {
    throw new Error("provide manifestPath or manifest, not both");
  }
  if (!input.manifestPath) return input.manifest;
  let size: number;
  try {
    size = statSync(input.manifestPath).size;
  } catch {
    throw new Error(`manifest file not found: ${input.manifestPath}`);
  }
  if (size > MAX_MANIFEST_BYTES) {
    throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(input.manifestPath, "utf8"));
  } catch (e) {
    throw new Error(`manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("manifest root must be an object or array");
  }
  return parsed;
}
