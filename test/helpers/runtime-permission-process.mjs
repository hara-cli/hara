import {until} from "./workspace-cli-mcp.mjs";
export const done=v=>["completed","blocked","paused","cancelled"].includes(v.conversation.state);
export async function exchange(f,q){await f.send(q);return until(f.read,done);}
export async function tier(f,value){const v=await f.read(),a=v.agents.find(x=>x.agentId===f.main.agentId);return f.request("workspace.agents.setPermissionTier",{...f.scope,agentId:a.agentId,permissionTier:value,configRevision:a.configRevision,agentEpoch:a.agentEpoch});}
