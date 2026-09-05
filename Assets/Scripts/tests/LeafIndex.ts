/**
 * LEAF scenario registry for WHEEL.
 *
 * ORDER DOES NOT MATTER, which I checked rather than assumed. Each
 * run_leaf_scenario resets the Lens first, so FIRING locking the piece cannot
 * leak into a later SHAPING run: re-running SHAPING after FIRING passes with
 * byte-identical numbers (radius 6.16 -> 7.08, delta 4.055), and re-running
 * FIRING passes again with a fresh seed. PERSISTENCE additionally snapshots
 * and restores the stored shelf, so it is safe even without the reset.
 */

import {scenariosIndex} from "Leaf.lspkg/Scenarios/decorator/ScenarioIndexDecorator";
import {ScenarioMetadata} from "Leaf.lspkg/Scenarios/scenario/ScenarioMetadata";
import {ShapingScenario} from "./ShapingScenario";
import {GlazeFallbackScenario} from "./GlazeFallbackScenario";
import {FiringScenario} from "./FiringScenario";
import {PersistenceScenario} from "./PersistenceScenario";

@component
export class LeafIndex extends BaseScriptComponent {
  @scenariosIndex
  static scenariosIndex: ScenarioMetadata[] = [
    {id: "wheel-shaping", typename: ShapingScenario.getTypeName()},
    {id: "wheel-glaze-fallback", typename: GlazeFallbackScenario.getTypeName()},
    {id: "wheel-firing", typename: FiringScenario.getTypeName()},
    {id: "wheel-persistence", typename: PersistenceScenario.getTypeName()}
  ];
}
