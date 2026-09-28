import { buildIsland } from "./builder";
import type { IslandSpec } from "./terrain";

self.onmessage = (e: MessageEvent<IslandSpec>) => {
  const b = buildIsland(e.data);
  const transfer: Transferable[] = [
    b.hi.positions.buffer,
    b.hi.normals.buffer,
    b.hi.colors.buffer,
    b.hi.indices.buffer,
    b.lo.positions.buffer,
    b.lo.normals.buffer,
    b.lo.colors.buffer,
    b.lo.indices.buffer,
    b.trees.buffer,
    b.houses.buffer,
    b.lights.buffer,
  ];
  (self as unknown as Worker).postMessage(b, transfer);
};
