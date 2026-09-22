/** Client-specific observed storage precision. Unknown clients are not assumed equivalent. */
const VIA_SIZE_GRID_MIL = Object.freeze({'4.1.60':0.1});
export function verifyNativeViaPrecision(normalized, clientVersion) {
  const grid=VIA_SIZE_GRID_MIL[clientVersion];
  if (!grid) return {known:false,clientVersion,checked:0};
  const issues=[];let checked=0;
  for (const op of normalized.operations) {
    if (op.kind!=='via'||op.type.endsWith('.delete')) continue;
    const state=op.state??{...op.expected,...op.set};checked++;
    for (const field of ['holeDiameter','diameter']) {
      const value=state[field], nearest=Math.round(value/grid)*grid;
      if (Math.abs(value-nearest)>1e-7) issues.push({operation:op.id,field,requestedMil:value,nearestStoredMil:nearest});
    }
  }
  if (issues.length) {
    const error=new Error('Client '+clientVersion+' stores via drill/pad sizes on a '+grid+' mil grid. Replan explicit representable sizes above the manufacturing minima and recheck annular ring; e.g. 12/24 mil = 0.3048/0.6096 mm. No native write performed.');
    error.code='CLIENT_UNSUPPORTED';error.details={clientVersion,gridMil:grid,issues};throw error;
  }
  return {known:true,clientVersion,gridMil:grid,checked};
}
