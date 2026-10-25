import assert from "node:assert/strict";
import test from "node:test";
import { withinCatalogRawObservationBounds as bounded } from "../src/treehouse_catalog_raw_bounds";

// This seam proves only resource budgets. These intentionally unsigned objects
// cannot pass the separate closed-header/authentication gate.
test("raw string budget is exact in UTF-8 bytes, including metadata", () => {
  const available = 64 * 1024 * 1024 - Buffer.byteLength("bodycapatomnil");
  for (const value of ["z".repeat(available), "é".repeat(available / 2)]) {
    assert.equal(bounded({body:["atom",value],cap:["nil"]}),true);
    assert.equal(bounded({body:["atom",value+"z"],cap:["nil"]}),false);
  }
});
function forest(nodes: number): unknown {
  if (nodes===1) return 0;
  const trees:unknown[]=[0], sizes=[1];
  while (sizes[sizes.length-1]! * 2 + 1 <= nodes) {
    trees.push([trees[trees.length-1],trees[trees.length-1]]);
    sizes.push(sizes[sizes.length-1]! * 2 + 1);
  }
  const children:unknown[]=[];
  let left=nodes-1;
  for(let n=sizes.length-1;n>=0;n--) while(left>=sizes[n]!) {
    children.push(trees[n]); left-=sizes[n]!;
  }
  assert.equal(left,0);
  return children;
}
test("aggregate node budget counts every logical occurrence of shared input", () => {
  // Root, its three keys, two nil arrays and two nil tags consume eight nodes.
  const available=64*1024*1024-8;
  assert.equal(bounded({body:["nil"],cap:["nil"],padding:forest(available)}),true);
  assert.equal(bounded({body:["nil"],cap:["nil"],padding:forest(available+1)}),false);
});
test("raw JSON depth and cycles cannot grow a traversal stack without bound", () => {
  const nested=(depth:number) => {let value:unknown=0;for(let i=0;i<depth;i++)value=[value];return value;};
  assert.equal(bounded({body:["nil"],cap:["nil"],padding:nested(198)}),true);
  assert.equal(bounded({body:["nil"],cap:["nil"],padding:nested(199)}),false);
  const cycle:unknown[]=[];cycle.push(cycle);
  assert.equal(bounded({body:cycle,cap:["nil"]}),false);
});
