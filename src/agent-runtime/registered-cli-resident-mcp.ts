import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { plain } from "../workspace/local-state.js";
import { WORKSPACE_MCP_TOKEN_ENV, type WorkspaceMcpEndpoint, type WorkspaceMcpAttemptInput } from "./registered-cli-mcp.js";
export const WORKSPACE_ATTEMPT_MARKER = "__hara_attempt";
interface Attempt { readonly input: WorkspaceMcpAttemptInput; readonly marker: string; readonly pending: Set<object>; ended: boolean; abort(): void }
/** Schema wrapping is optional. Unknown schemas keep the immutable one-attempt transport. */
export function residentMcpToolsSupported(input: WorkspaceMcpAttemptInput): boolean {
  return input.tools().every(tool => tool.input_schema.type === "object" && (tool.input_schema.properties === undefined || plain(tool.input_schema.properties))
    && !Object.hasOwn((tool.input_schema.properties ?? {}) as object, WORKSPACE_ATTEMPT_MARKER)
    && (tool.input_schema.required === undefined || Array.isArray(tool.input_schema.required) && tool.input_schema.required.every(key => typeof key === "string")));
}
/** A transport is resident. No tool capability survives its immutable attempt/marker binding. */
export class ResidentWorkspaceMcp {
  private active?: Attempt;
  private closed = false;
  private poisoned = false;
  private retired = false;
  private phase: "idle" | "binding" | "active" | "draining" = "idle";
  private pending = 0;
  private readonly expected: Buffer;
  private readonly server: Server;
  private readonly transport: StreamableHTTPServerTransport;
  private readonly http: ReturnType<typeof createServer>;
  private authority = "";
  private closing?: Promise<void>;
  private constructor(private readonly bearer: string) {
    this.expected = Buffer.from("Bearer " + bearer);
    this.transport = new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:true,maxRequestBodySize:256*1024});
    this.server = new Server({name:"hara",version:"1.0.0"},{capabilities:{tools:{listChanged:true}},
      instructions:"Hara governs every tool call and confirmation. Every call must include the __hara_attempt from the current Host turn reminder. A transport connection or attempt marker never grants approval. Never reuse a marker from an earlier turn."});
    const unavailable = () => new McpError(ErrorCode.InvalidRequest,"Workspace MCP attempt unavailable");
    this.server.setRequestHandler(ListToolsRequestSchema,async()=>{
      try {
        const binding=this.capture();
        const tools=binding.input.tools().map(tool=>({name:tool.name,description:tool.description,inputSchema:{...tool.input_schema,
          properties:{...(tool.input_schema.properties as Record<string,unknown>??{}),[WORKSPACE_ATTEMPT_MARKER]:{type:"string",description:"Exact __hara_attempt in the current Host turn reminder; never use an earlier turn marker."}},
          required:[...new Set([...(tool.input_schema.required as string[]??[]),WORKSPACE_ATTEMPT_MARKER])]}}));
        this.assert(binding);return{tools};
      }catch{throw unavailable();}
    });
    this.server.setRequestHandler(CallToolRequestSchema,async request=>{
      let binding:Attempt|undefined, flight:object|undefined;
      try{
        const parameters=request.params.arguments??{};
        binding=this.capture();
        if(parameters[WORKSPACE_ATTEMPT_MARKER]!==binding.marker||binding.pending.size>=16)throw unavailable();
        const { [WORKSPACE_ATTEMPT_MARKER]:_marker,...args }=parameters;
        if(!binding.input.tools().some(tool=>tool.name===request.params.name))throw unavailable();
        flight={};binding.pending.add(flight);this.pending++;
        const result=await binding.input.call(request.params.name,args);
        this.assert(binding); // Same captured binding after every async boundary, never retarget.
        return{content:[{type:"text" as const,text:result.content}],...(result.isError?{isError:true}:{})};
      }catch{throw unavailable();}
      finally{if(binding&&flight){binding.pending.delete(flight);this.pending--;}}
    });
    const reject=(response:ServerResponse,code:number)=>{response.writeHead(code,{"Content-Type":"application/json","Cache-Control":"no-store"});response.end(JSON.stringify({error:"Workspace MCP request refused"}));};
    this.http=createServer((request,response)=>{
      const auth=request.headers.authorization,supplied=typeof auth==="string"&&auth.length<=80?Buffer.from(auth):Buffer.alloc(0);
      if(supplied.length!==this.expected.length||!timingSafeEqual(supplied,this.expected)){reject(response,401);return;}
      if(request.url!=="/mcp"||request.headers.host!==this.authority||(request.headers.origin!==undefined&&request.headers.origin!=="http://"+this.authority)
        ||!["127.0.0.1","::ffff:127.0.0.1"].includes(request.socket.remoteAddress??"")){reject(response,403);return;}
      try{this.capture();}catch{reject(response,403);return;}
      void this.transport.handleRequest(request,response).catch(()=>{if(!response.headersSent)reject(response,400);else response.destroy();});
    });
    this.http.requestTimeout=15_000;this.http.headersTimeout=15_000;this.http.keepAliveTimeout=1000;
  }
  static async create(bearer:string):Promise<ResidentWorkspaceMcp>{
    if(!/^[a-f0-9]{64}$/.test(bearer))throw new Error("Invalid resident MCP bearer");
    const value=new ResidentWorkspaceMcp(bearer);
    try{
      await value.server.connect(value.transport);
      await new Promise<void>((resolve,reject)=>{value.http.once("error",reject);value.http.listen(0,"127.0.0.1",()=>{value.http.off("error",reject);resolve();});});
      const address=value.http.address();if(!address||typeof address==="string")throw new Error("Resident MCP listener unavailable");
      value.authority="127.0.0.1:"+address.port;return value;
    }catch(error){await value.close();throw error;}
  }
  private assert(binding:Attempt):void{
    if(this.closed||this.phase!=="active"||this.active!==binding||binding.ended||binding.input.signal.aborted
      ||binding.input.expiresAt!==undefined&&Date.now()>=binding.input.expiresAt)throw new Error("Workspace MCP attempt ended");
    binding.input.assertCurrent();
  }
  private capture():Attempt{const value=this.active;if(!value)throw new Error("Workspace MCP is idle");this.assert(value);return value;}
  get reusable():boolean{return !this.closed&&!this.poisoned&&this.retired&&this.phase==="idle"&&this.pending===0;}
  bind(input:WorkspaceMcpAttemptInput):WorkspaceMcpEndpoint{
    input.assertCurrent();
    if(this.closed||this.poisoned||this.phase!=="idle"||this.pending||input.signal.aborted||!residentMcpToolsSupported(input))throw new Error("Resident MCP binding unavailable");
    if(input.expiresAt!==undefined&&(!Number.isFinite(input.expiresAt)||input.expiresAt<=Date.now()))throw new Error("Workspace MCP attempt expired");
    this.phase="binding";
    const binding:Attempt={input:Object.freeze({...input}),marker:randomBytes(24).toString("hex"),pending:new Set(),ended:false,abort:()=>{this.retire(binding);}};
    this.active=binding;this.phase="active";input.signal.addEventListener("abort",binding.abort,{once:true});
    const env:NodeJS.ProcessEnv={[WORKSPACE_MCP_TOKEN_ENV]:this.bearer};
    return Object.freeze({url:"http://"+this.authority+"/mcp",env,attemptMarker:binding.marker,
      close:async()=>{this.retire(binding);delete env[WORKSPACE_MCP_TOKEN_ENV];}});
  }
  /** Synchronous revoke first. A pending old call poisons reuse until the transport is replaced. */
  retireCurrent():boolean{return this.active?this.retire(this.active):!this.poisoned&&this.pending===0;}
  private retire(binding:Attempt):boolean{
    if(this.active!==binding)return binding.pending.size===0;
    this.phase="draining";binding.ended=true;this.active=undefined;binding.input.signal.removeEventListener("abort",binding.abort);
    if(binding.pending.size)this.poisoned=true;
    this.retired=true;this.phase="idle";return !this.poisoned&&this.pending===0;
  }
  close():Promise<void>{return this.closing??=(async()=>{
    this.retireCurrent();this.closed=true;this.expected.fill(0);
    await this.server.close().catch(()=>{});
    await new Promise<void>(resolve=>{this.http.close(()=>resolve());this.http.closeAllConnections();});
  })();}
}
