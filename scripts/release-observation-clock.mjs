/** Bound genuine wall-clock catch-up by independent monotonic time. The
 * remote observation and its original freshness deadline are never rewritten. */
export async function awaitObservationTime(observedAtMilliseconds,{clock=Date.now,monotonic=()=>performance.now(),wait=ms=>new Promise(r=>setTimeout(r,ms)),maximumWaitMilliseconds=5000,maximumAgeMilliseconds=300000,maximumSamples=128}={}){
 const started=monotonic(),initial=clock(),samples=[];let previousWall=initial,previousMono=started;
 const observation=()=>({format:1,kind:'bounded-observation-clock',observedAtMilliseconds,
  initialLocalMilliseconds:initial,maximumWaitMilliseconds,maximumFactsAgeMilliseconds:maximumAgeMilliseconds,samples,
  clockAdjusted:false,factsTimestampChanged:false,freshnessExtended:false});
 const refuse=reason=>{const error=Error(reason);error.clockObservation=observation();throw error;};
 if(!Number.isSafeInteger(maximumWaitMilliseconds)||maximumWaitMilliseconds<1||maximumWaitMilliseconds>5000
  ||!Number.isSafeInteger(maximumAgeMilliseconds)||maximumAgeMilliseconds<1||maximumAgeMilliseconds>900000
  ||!Number.isSafeInteger(maximumSamples)||maximumSamples<1||maximumSamples>128)refuse('observation-clock-policy-invalid');
 if(!Number.isSafeInteger(observedAtMilliseconds)||!Number.isSafeInteger(initial)||!Number.isFinite(started))refuse('observation-timestamp-invalid');
 if(observedAtMilliseconds-initial>maximumWaitMilliseconds)refuse('observation-clock-offset-exceeded');
 for(let attempt=0;attempt<maximumSamples;attempt++){
  const local=clock(),mono=monotonic(),elapsed=mono-started;
  samples.push({localMilliseconds:local,elapsedMilliseconds:elapsed});
  if(!Number.isSafeInteger(local)||!Number.isFinite(mono)||mono<previousMono)refuse('observation-monotonic-clock-invalid');
  if(local<previousWall)refuse('observation-local-clock-moved-backward');
  if(elapsed>maximumWaitMilliseconds)refuse('observation-clock-wait-budget-expired');
  const age=local-observedAtMilliseconds;
  if(age>maximumAgeMilliseconds)refuse('observation-expired');
  if(age>=0)return{...observation(),admittedAtMilliseconds:local,factsAgeMilliseconds:age};
  if(elapsed===maximumWaitMilliseconds)refuse('observation-local-clock-did-not-catch-up');
  previousWall=local;previousMono=mono;
  try{await wait(Math.min(50,-age,maximumWaitMilliseconds-elapsed));}catch{refuse('observation-clock-wait-interrupted');}
 }
 refuse('observation-clock-did-not-progress');
}
