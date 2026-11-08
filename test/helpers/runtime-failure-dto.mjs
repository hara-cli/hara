// Test consumer for the existing flat diagnostic envelope; the governor may append a human hint.
export function runtimeFailureDto(message) {
  const marker="hara_runtime_failure_v1=",index=typeof message==="string"?message.indexOf(marker):-1;
  const invalid=()=>{throw new Error("Expected one bounded flat runtime failure envelope");};
  if(index<0||message.length>=4096||message.indexOf(marker,index+marker.length)>=0)return invalid();
  const source=message.slice(index+marker.length);if(source[0]!=="{")return invalid();
  let quoted=false,escaped=false,start=0;const keys=new Set();
  for(let i=1;i<source.length;i++){
    const char=source[i];if(char==="\n"||char==="\r")return invalid();
    if(quoted){if(escaped){escaped=false;continue;}if(char==="\\"){escaped=true;continue;}if(char==='"'){quoted=false;if(/^\s*:/.test(source.slice(i+1))){const key=JSON.parse(source.slice(start,i+1));if(keys.has(key))return invalid();keys.add(key);}}}
    else if(char==='"'){quoted=true;start=i;}
    else if(char==="{"||char==="[")return invalid();
    else if(char==="}")return JSON.parse(source.slice(0,i+1));
  }
  return invalid();
}
