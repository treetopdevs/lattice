import type { CatalogBindingAccepted, CatalogBindingBlocked, CatalogBindingGraphResult } from "../../src/treehouse_catalog_binding_graph";
export declare const vectorUrl: import("node:url").URL;
export declare const tsVectorUrl: import("node:url").URL;
type Json = any;
interface State {
    accepted: CatalogBindingAccepted | null;
    blocked: CatalogBindingBlocked | null;
}
export declare function loadVector(): Json;
/** The id-space view, same shape as CatalogBindingGraphFixtures.view/1. */
export declare function idView(result: CatalogBindingGraphResult): Json;
/** The label-space view, same shape as CatalogBindingGraphScenarios.label_view/2. */
export declare function labelView(result: CatalogBindingGraphResult, labels: Record<string, string>): Json;
export interface StepOutcome {
    scenario: string;
    step: number;
    expect: Json;
    beam: Json;
    label: Json;
    id: Json;
    stateIn: State;
    beamStateIn: Json;
}
/** Run every scenario step through the TS resolver with persisted state. */
export declare function runVector(vector?: Json): Promise<StepOutcome[]>;
export {};
