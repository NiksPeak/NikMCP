// Live runtime attach regression guard.
//
// Requirements: `npm run build`, Studio open with the NikMCP plugin connected
// to this spawned bridge, and a place where StudioTestService can start Run mode.
// This fails the exact regression where edit context is alive but the F5/F8
// runtime server agent never attaches.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  stderr: "inherit",
});
const client = new Client({ name: "runtime-attach-smoke", version: "1.0.0" });
await client.connect(transport);

function textOf(result) {
  return (result.content || []).map((c) => c.text ?? `[${c.type}]`).join("\n");
}

function parseJsonTool(result, label) {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: response was not JSON: ${text.slice(0, 500)}`);
  }
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = textOf(result);
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return { result, text };
}

try {
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const before = parseJsonTool((await call("get_status")).result, "get_status before");
  if (before.edit?.connected !== true) {
    throw new Error(`edit context is not connected: ${JSON.stringify(before, null, 2)}`);
  }

  const smoke = await call("playtest_smoke", {
    steps: [
      {
        description: "runtime server can execute and engine is running",
        luau:
          "local RunService = game:GetService('RunService') " +
          "return RunService:IsRunning() and RunService:IsServer()",
        expectTruthy: true,
      },
    ],
    stopAfter: true,
    collectOutput: true,
    skipAnalysis: false,
  });
  if (!/SMOKE:\s*1\/1 steps passed/.test(smoke.text)) {
    throw new Error(`runtime smoke did not pass: ${smoke.text.slice(0, 1000)}`);
  }

  const after = parseJsonTool((await call("get_status")).result, "get_status after");
  if (after.serverAgent?.connected || after.clientAgent?.connected || after.runtimeSessionId) {
    throw new Error(`runtime did not settle after stop: ${JSON.stringify(after, null, 2)}`);
  }

  console.log("runtime-attach-smoke: PASS");
  console.log(
    JSON.stringify(
      {
        before: {
          port: before.bridge?.port,
          placeId: before.activePlaceId,
          placeName: before.activePlaceName,
          edit: before.edit,
        },
        smoke: "1/1 steps passed",
        after: {
          running: after.running,
          serverAgent: after.serverAgent,
          clientAgent: after.clientAgent,
          runtimeSessionId: after.runtimeSessionId,
        },
      },
      null,
      2
    )
  );
} finally {
  await client.close().catch(() => {});
}
