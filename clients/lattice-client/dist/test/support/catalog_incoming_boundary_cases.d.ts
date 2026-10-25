import type { trustFixture } from "./export_treehouse_catalog_trust";
export type ProbeInput = [string, unknown[], unknown[]?];
type Fixture = Awaited<ReturnType<typeof trustFixture>>;
export declare function boundaryCases(f: Fixture): Promise<ProbeInput[]>;
export {};
