// Open Cloud asset upload (task 23 batch C). Node-side ONLY -- the API key never
// reaches the plugin, the bridge wire, or a log line. Dependency-free: Node 18+
// global fetch/FormData/Blob, same ethos as png-encoder.ts.

export interface OpenCloudCreator {
  userId?: number;
  groupId?: number;
}

const MAX_BYTES = 20 * 1024 * 1024;

// Exact documented Open Cloud request shape. Ids are strings inside `creator`
// per current docs ("userId":"123") even though callers pass numbers.
export function buildAssetRequest(
  assetType: string,
  displayName: string,
  description: string | undefined,
  creator: OpenCloudCreator
): object {
  let creatorObj: { userId: string } | { groupId: string };
  if (creator.userId !== undefined) {
    creatorObj = { userId: String(creator.userId) };
  } else if (creator.groupId !== undefined) {
    creatorObj = { groupId: String(creator.groupId) };
  } else {
    throw new Error("creator requires exactly one of userId or groupId");
  }
  return {
    assetType,
    displayName,
    description,
    creationContext: { creator: creatorObj },
  };
}

// Reject oversized files ourselves instead of letting the API 4xx tell us.
export function preflightSize(bytes: number): string | null {
  if (bytes > MAX_BYTES) {
    return `file is ${bytes} bytes; Open Cloud caps uploads at 20 MB`;
  }
  return null;
}

// Scrub every occurrence of the key from a string. Safe on an empty key (no-op) --
// callers must run every thrown/logged message through this before it leaves the module.
export function redactKey(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join("<redacted>");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared fetch wrapper: one 429 retry after a 1s backoff, 401/403 -> the
// documented key/permission error, other non-OK -> status + redacted body
// snippet. Every thrown message is redacted before it leaves this function.
async function fetchJson(url: string, init: RequestInit, apiKey: string): Promise<any> {
  let res = await fetch(url, init);
  if (res.status === 429) {
    console.error("Open Cloud 429; retrying once after backoff");
    await sleep(1000);
    res = await fetch(url, init);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("Open Cloud key invalid or missing asset:write permission for this creator");
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const snippet = redactKey(bodyText, apiKey).slice(0, 300);
    throw new Error(redactKey(`Open Cloud request failed: ${res.status} ${res.statusText} - ${snippet}`, apiKey));
  }
  return res.json();
}

export async function uploadAsset(opts: {
  apiKey: string;
  creator: OpenCloudCreator;
  assetType: "Image" | "Decal" | "Audio" | "Model";
  displayName: string;
  description?: string;
  bytes: Buffer;
  contentType: string;
}): Promise<{ assetId: string; moderationState: string }> {
  const { apiKey, creator, assetType, displayName, description, bytes, contentType } = opts;

  const sizeErr = preflightSize(bytes.length);
  if (sizeErr) throw new Error(sizeErr);

  try {
    const request = buildAssetRequest(assetType, displayName, description, creator);
    const form = new FormData();
    form.append("request", JSON.stringify(request));
    // ponytail: filename is cosmetic -- Open Cloud types the file from contentType, not this name.
    form.append("fileContent", new Blob([new Uint8Array(bytes)], { type: contentType }), "fileContent");

    const created = await fetchJson(
      "https://apis.roblox.com/assets/v1/assets",
      { method: "POST", headers: { "x-api-key": apiKey }, body: form },
      apiKey
    );

    const opPath: string | undefined =
      created.path ?? (created.operationId ? `operations/${created.operationId}` : undefined);
    if (!opPath) {
      throw new Error(`Open Cloud response missing operation path: ${JSON.stringify(created)}`);
    }
    const opId = opPath.split("/").pop() ?? opPath;
    const pollUrl = `https://apis.roblox.com/assets/v1/${opPath}`;

    // Backoff 1s -> 2s -> 4s, capped at 5s per wait, 90s total wait budget.
    const delays = [1000, 2000, 4000, 5000];
    let waited = 0;
    let step = 0;
    for (;;) {
      const op = await fetchJson(pollUrl, { headers: { "x-api-key": apiKey } }, apiKey);
      if (op.done) {
        const assetId = op.response?.assetId;
        const moderationState = op.response?.moderationResult?.moderationState ?? "Unknown";
        if (!assetId) {
          throw new Error(`Open Cloud operation completed without an assetId: ${JSON.stringify(op)}`);
        }
        return { assetId: String(assetId), moderationState };
      }
      const delay = delays[Math.min(step, delays.length - 1)];
      step++;
      if (waited + delay > 90000) {
        throw new Error(`operation timed out after 90s (operation ${opId} may still complete)`);
      }
      await sleep(delay);
      waited += delay;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(redactKey(msg, apiKey));
  }
}
