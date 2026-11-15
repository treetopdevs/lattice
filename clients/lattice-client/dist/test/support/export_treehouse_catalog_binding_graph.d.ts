import type { CatalogBindingAdvance, CatalogBindingGraphResult, CatalogBindingState } from "../../src/treehouse_catalog_binding_graph";
export declare const vectorUrl: import("node:url").URL;
export declare const tsVectorUrl: import("node:url").URL;
type Json = any;
type State = CatalogBindingState;
export declare function loadVector(): Json;
/** The JSON shape of CatalogBindingGraphFixtures.state_json/1 (routes keyed in sorted order). */
export declare function stateJson(state: State): Json;
/** The id-space view, same shape as CatalogBindingGraphFixtures.view/1. */
export declare function idView(result: CatalogBindingGraphResult, next: CatalogBindingAdvance): Json;
/** The label-space view, same shape as CatalogBindingGraphScenarios.label_view/2. */
export declare function labelView(result: CatalogBindingGraphResult, labels: Record<string, string>, next: CatalogBindingAdvance): Json;
export interface StepOutcome {
    scenario: string;
    step: number;
    expect: Json;
    beam: Json;
    label: Json;
    id: Json;
    stateIn: Json;
    beamStateIn: Json;
}
/** Run every scenario step through the TS resolver with persisted state. */
export declare function runVector(vector?: Json): Promise<StepOutcome[]>;
export {};
