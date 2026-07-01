// KeyframeSequence JSON (serialized by the plugin) -> .rbxmx (XML) string.
// Pure + dependency-free. The XML is then converted to binary .rbxm by rojo
// (src/rojo.ts) before the Open Cloud upload -- Open Cloud rejects XML rbxmx.
//
// Enum tokens (Priority / EasingStyle / EasingDirection) are written from the
// numeric `.Value` the plugin reads off the live EnumItem -- ground truth from the
// engine, so there are no hardcoded enum tables here to drift against Roblox.

export interface AnimCFrame {
  __t: "CFrame";
  comps: number[]; // 12: x,y,z, R00,R01,R02,R10,R11,R12,R20,R21,R22
}

export interface AnimPose {
  part: string;
  cframe: AnimCFrame;
  weight?: number;
  easingStyleValue?: number; // Enum.PoseEasingStyle.Value (default Linear = 0)
  easingDirectionValue?: number; // Enum.PoseEasingDirection.Value
  subPoses?: AnimPose[];
}

export interface AnimKeyframe {
  time: number;
  name?: string;
  poses: AnimPose[];
}

export interface AnimKfs {
  loop?: boolean;
  priorityValue?: number; // Enum.AnimationPriority.Value (default Action = 2)
  keyframes: AnimKeyframe[];
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fnum(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "0";
}

// referent generator: rbx_xml only needs unique tokens, not Roblox's exact format.
function makeRef(): () => string {
  let i = 0;
  return () => "RBX" + i++;
}

function cframeXml(cf: AnimCFrame): string {
  const c = Array.isArray(cf?.comps) ? cf.comps : [];
  const v = (i: number) => fnum(c[i]);
  // CFrame.GetComponents() order: position then the 3x3 rotation matrix.
  return (
    `    <CoordinateFrame name="CFrame">\n` +
    `     <X>${v(0)}</X><Y>${v(1)}</Y><Z>${v(2)}</Z>\n` +
    `     <R00>${v(3)}</R00><R01>${v(4)}</R01><R02>${v(5)}</R02>\n` +
    `     <R10>${v(6)}</R10><R11>${v(7)}</R11><R12>${v(8)}</R12>\n` +
    `     <R20>${v(9)}</R20><R21>${v(10)}</R21><R22>${v(11)}</R22>\n` +
    `    </CoordinateFrame>\n`
  );
}

function poseXml(pose: AnimPose, ref: () => string): string {
  const weight = typeof pose.weight === "number" ? pose.weight : 1;
  const easeStyle = typeof pose.easingStyleValue === "number" ? pose.easingStyleValue : 0;
  const easeDir = typeof pose.easingDirectionValue === "number" ? pose.easingDirectionValue : 0;
  let xml =
    `   <Item class="Pose" referent="${ref()}">\n` +
    `    <Properties>\n` +
    `     <string name="Name">${esc(pose.part)}</string>\n` +
    cframeXml(pose.cframe) +
    `     <float name="Weight">${fnum(weight)}</float>\n` +
    `     <token name="EasingStyle">${fnum(easeStyle)}</token>\n` +
    `     <token name="EasingDirection">${fnum(easeDir)}</token>\n` +
    `    </Properties>\n`;
  if (Array.isArray(pose.subPoses)) {
    for (const sub of pose.subPoses) {
      xml += poseXml(sub, ref);
    }
  }
  xml += `   </Item>\n`;
  return xml;
}

// Build the full <roblox> document with the KeyframeSequence as the single root.
export function buildAnimRbxmx(kfs: AnimKfs): string {
  const ref = makeRef();
  const loop = kfs.loop === true;
  const priority = typeof kfs.priorityValue === "number" ? kfs.priorityValue : 2;
  let body = "";
  for (const kf of kfs.keyframes ?? []) {
    body +=
      `  <Item class="Keyframe" referent="${ref()}">\n` +
      `   <Properties>\n` +
      `    <string name="Name">${esc(kf.name ?? "Keyframe")}</string>\n` +
      `    <float name="Time">${fnum(kf.time)}</float>\n` +
      `   </Properties>\n`;
    for (const pose of kf.poses ?? []) {
      body += poseXml(pose, ref);
    }
    body += `  </Item>\n`;
  }
  return (
    `<roblox version="4">\n` +
    ` <Item class="KeyframeSequence" referent="${ref()}">\n` +
    `  <Properties>\n` +
    `   <bool name="Authored">true</bool>\n` +
    `   <bool name="Loop">${loop ? "true" : "false"}</bool>\n` +
    `   <string name="Name">Animation</string>\n` +
    `   <token name="Priority">${fnum(priority)}</token>\n` +
    `  </Properties>\n` +
    body +
    ` </Item>\n` +
    `</roblox>\n`
  );
}
