import {analyzeCopperTopology} from './copper-topology.mjs';

/** Shared physical-copper model for connectivity and endpoint-path reports. */
export function analyzeConnectivity(snapshot,options={}) {
 return analyzeCopperTopology(snapshot,options);
}
