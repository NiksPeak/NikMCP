// Open Cloud Assets upload (Animation) + operation polling. Node-side only; the API
// key is passed in by the caller (read from env/credentials at call time) and is
// never logged here. Endpoints/types are constants in ONE place + overridable via
// config, so a Roblox contract change doesn't need code surgery.
// Reference: https://create.roblox.com/docs/cloud/guides/usage-assets

export const ASSETS_URL = "https://apis.roblox.com/assets/v1/assets";
export const OPERATIONS_URL = "https://apis.roblox.com/assets/v1/operations";
export const DEFAULT_ASSET_TYPE = "Animation";
export const DEFAULT_FILE_CONTENT_TYPE = "model/x-rbxm";

const NAME_MAX = 50;
const DESC_MAX = 1000;
const POLL_MAX_MS = 60_000;

export type Guard<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ValidatedInput {
  name: string;
  description: string;
}

// name 1-50 after trim; description <= 1000 (reject, naming the limit). Pure.
export function validateUploadInput(raw: { name?: unknown; description?: unknown }): Guard<ValidatedInput> {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length < 1 || name.length > NAME_MAX) {
    return { ok: false, error: `upload_animation: name must be 1-${NAME_MAX} chars after trim` };
  }
  const description = typeof raw.description === "string" ? raw.description : "";
  if (description.length > DESC_MAX) {
    return { ok: false, error: `upload_animation: description exceeds ${DESC_MAX} chars` };
  }
  return { ok: true, value: { name, description } };
}

export type Creator = { userId: number } | { groupId: number };

// Resolve the creator: call arg (creatorId + creatorType) wins, else user config
// (userId or groupId). Pure; no network. Rejects when neither is present.
export function resolveCreator(
  arg: { creatorId?: number; creatorType?: string },
  cfgCreator: { userId?: number; groupId?: number } | undefined
): Guard<Creator> {
  if (typeof arg.creatorId === "number" && Number.isFinite(arg.creatorId)) {
    const id = Math.floor(arg.creatorId);
    return { ok: true, value: arg.creatorType === "group" ? { groupId: id } : { userId: id } };
  }
  if (cfgCreator) {
    if (typeof cfgCreator.userId === "number" && cfgCreator.userId > 0) {
      return { ok: true, value: { userId: Math.floor(cfgCreator.userId) } };
    }
    if (typeof cfgCreator.groupId === "number" && cfgCreator.groupId > 0) {
      return { ok: true, value: { groupId: Math.floor(cfgCreator.groupId) } };
    }
  }
  return {
    ok: false,
    error:
      "upload_animation: no creator configured. Pass creatorId, or run " +
      "`nikmcp set-creator <id> [--group]`, or set it in the dock Open Cloud panel.",
  };
}

export interface UploadResult {
  assetId: number;
  animationId: string;
  name: string;
  moderation?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readModeration(response: unknown): string | undefined {
  const m = (response as { moderationResult?: { moderationState?: string } } | undefined)?.moderationResult;
  return m?.moderationState;
}

// POST the binary .rbxm as multipart/form-data, then poll the returned operation
// until done. Returns the real assetId or a real error -- never a fabricated id.
export async function uploadAnimation(opts: {
  key: string;
  creator: Creator;
  rbxm: Buffer | Uint8Array;
  name: string;
  description: string;
  assetType?: string;
  fileContentType?: string;
}): Promise<Guard<UploadResult>> {
  const assetType = opts.assetType || DEFAULT_ASSET_TYPE;
  const fileContentType = opts.fileContentType || DEFAULT_FILE_CONTENT_TYPE;
  const request = {
    assetType,
    displayName: opts.name,
    description: opts.description,
    creationContext: { creator: opts.creator },
  };

  let postText: string;
  let postStatus: number;
  try {
    const fd = new FormData();
    fd.append("request", JSON.stringify(request));
    // Copy into a fresh Uint8Array (ArrayBuffer-backed) so it is a valid BlobPart
    // regardless of how the Buffer was pooled.
    const bytes = Uint8Array.from(opts.rbxm);
    fd.append("fileContent", new Blob([bytes], { type: fileContentType }), "animation.rbxm");
    const res = await fetch(ASSETS_URL, {
      method: "POST",
      headers: { "x-api-key": opts.key },
      body: fd,
    });
    postStatus = res.status;
    postText = await res.text();
  } catch (e) {
    return { ok: false, error: "Open Cloud upload request failed: " + String(e) };
  }
  if (postStatus < 200 || postStatus >= 300) {
    return { ok: false, error: `Open Cloud POST ${postStatus}: ${postText}` };
  }

  let op: { done?: boolean; operationId?: string; path?: string; response?: { assetId?: string | number } };
  try {
    op = JSON.parse(postText);
  } catch {
    return { ok: false, error: "Open Cloud returned a non-JSON operation: " + postText };
  }

  const finish = (response: { assetId?: string | number } | undefined): Guard<UploadResult> => {
    const assetId = response?.assetId !== undefined ? Number(response.assetId) : NaN;
    if (!Number.isFinite(assetId) || assetId <= 0) {
      return { ok: false, error: "Open Cloud operation done but no assetId returned" };
    }
    return {
      ok: true,
      value: {
        assetId,
        animationId: "rbxassetid://" + assetId,
        name: opts.name,
        moderation: readModeration(response),
      },
    };
  };

  if (op.done) {
    return finish(op.response);
  }
  const operationId = op.operationId || (op.path ? op.path.split("/").pop() : undefined);
  if (!operationId) {
    return { ok: false, error: "Open Cloud did not return an operationId to poll" };
  }

  const start = Date.now();
  let delay = 1000;
  while (Date.now() - start < POLL_MAX_MS) {
    await sleep(delay);
    let pollText: string;
    let pollStatus: number;
    try {
      const res = await fetch(`${OPERATIONS_URL}/${operationId}`, {
        headers: { "x-api-key": opts.key },
      });
      pollStatus = res.status;
      pollText = await res.text();
    } catch (e) {
      return { ok: false, error: "Open Cloud poll request failed: " + String(e) };
    }
    if (pollStatus < 200 || pollStatus >= 300) {
      return { ok: false, error: `Open Cloud poll ${pollStatus}: ${pollText}` };
    }
    let pop: { done?: boolean; response?: { assetId?: string | number }; error?: unknown };
    try {
      pop = JSON.parse(pollText);
    } catch {
      return { ok: false, error: "Open Cloud poll returned non-JSON: " + pollText };
    }
    if (pop.error) {
      return { ok: false, error: "Open Cloud operation error: " + JSON.stringify(pop.error) };
    }
    if (pop.done) {
      return finish(pop.response);
    }
    delay = Math.min(Math.floor(delay * 1.5), 5000);
  }
  return {
    ok: false,
    error: `upload still processing after ${POLL_MAX_MS / 1000}s (operation ${operationId}); not claiming an asset id`,
  };
}
