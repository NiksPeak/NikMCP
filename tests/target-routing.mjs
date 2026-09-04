import assert from "node:assert/strict";
import http from "node:http";
import {
  configureStudioTargets,
  discoverStudioTargets,
  resetStudioTargetsForTests,
  routeSelectedCommand,
  selectStudioTarget,
} from "../dist/studio-targets.js";
import { dequeue, enqueueLocalAndAwait } from "../dist/queue.js";

process.env.NIKMCP_INTERNAL_ROUTING_TOKEN ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let targetId = "studio-test-a";
let invokeCount = 0;
let lastInvoke = null;
let lastRouteToken = null;

const server = http.createServer((req, res) => {
  if (req.url === "/target" && req.method === "GET") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      kind: "nikmcp-studio-target",
      targetId,
      studioSessionId: targetId.slice("studio-".length),
      bridgePort: server.address().port,
      windowTitle: "Routing Test - Roblox Studio",
      studioPid: 1234,
      placeId: 10,
      universeId: 20,
      placeName: "Routing Test",
      placeFilePath: null,
      state: "edit",
      health: {
        bridge: true,
        plugin: true,
        runtimeAgent: false,
        editAgeMs: 10,
        serverAgeMs: null,
      },
      connectedToThisMcp: false,
      selected: false,
    }));
    return;
  }
  if (req.url === "/invoke" && req.method === "POST") {
    lastRouteToken = req.headers["x-nikmcp-route-token"];
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      invokeCount += 1;
      lastInvoke = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "peer-result", ok: true, result: { routed: true } }));
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

try {
  configureStudioTargets({ basePort: port, portRange: 1, localPort: () => port + 1 });

  const targets = await discoverStudioTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].targetId, "studio-test-a");
  assert.equal(targets[0].bridgePort, port);

  await assert.rejects(
    () => selectStudioTarget({}),
    /requires targetId or bridgePort/
  );
  await assert.rejects(
    () => selectStudioTarget({ targetId: "studio-missing" }),
    /no reachable Studio target/
  );
  await assert.rejects(
    () => selectStudioTarget({ bridgePort: port + 9 }),
    /no reachable Studio target/
  );

  const selected = await selectStudioTarget({ bridgePort: port });
  assert.equal(selected.targetId, "studio-test-a");

  const routed = await routeSelectedCommand("get_place_info", "edit", {}, 1000);
  assert.equal(routed?.ok, true);
  assert.equal(invokeCount, 1);
  assert.equal(lastInvoke.expectedTargetId, "studio-test-a");
  assert.equal(lastInvoke.context, "edit");
  assert.equal(lastInvoke.type, "get_place_info");
  assert.match(lastRouteToken, /^[0-9a-f]{64}$/);

  await assert.rejects(
    () => routeSelectedCommand("get_place_info", "edit", {}, 1000, "studio-wrong"),
    /command target changed before routing/,
  );
  assert.equal(invokeCount, 1);

  // Exact regression guard: a port that now belongs to another Studio window
  // must fail before /invoke, never silently execute in the replacement window.
  targetId = "studio-test-b";
  await assert.rejects(
    () => routeSelectedCommand("delete_instance", "edit", { path: "Workspace.X" }, 1000),
    /identity changed/
  );
  assert.equal(invokeCount, 1);

  const expired = enqueueLocalAndAwait("stale_test", "edit", {}, 10);
  await assert.rejects(expired, /timed out/);
  assert.equal(dequeue("edit"), undefined, "timed-out command must be removed from its queue");

  console.log("target-routing: PASS (discovery, capability, identity drift, stale queue cleanup)");
} finally {
  resetStudioTargetsForTests();
  await new Promise((resolve) => server.close(resolve));
}
