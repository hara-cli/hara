/** Fixed taskbus operations shared by the authenticated Desktop RPC and terminal client. */
export interface TaskbusInput { operation: string; input?: Record<string, unknown>; }
export function taskbusRoute(operation: string, input: Record<string, unknown> = {}): {
  method: "GET" | "POST"; path: string; body?: Record<string, unknown>; runtime: boolean;
} {
  if (JSON.stringify(input).length > 64_000) throw new Error("taskbus input exceeds 64 KB");
  const resource = (name: string, pattern = /^[A-Za-z0-9._:@-]{1,160}$/): string => {
    const value = input[name];
    if (typeof value !== "string" || !pattern.test(value)) throw new Error(`valid ${name} required`);
    return value;
  };
  let method: "GET" | "POST" = "GET", path: string, runtime = false;
  switch (operation) {
    case "capabilities": path = "/capabilities"; break;
    case "identity": path = "/identity"; break;
    case "directory": path = "/directory"; break;
    case "members.list": path = "/members"; break;
    case "members.save": path = `/members/${resource("memberId", /^[A-Za-z0-9_-]{1,80}$/)}`; method = "POST"; break;
    case "projects.list": path = "/projects"; break;
    case "projects.save": path = "/projects"; method = "POST"; break;
    case "bindings.list": path = "/mail-bindings"; break;
    case "bindings.save": path = "/mail-bindings"; method = "POST"; break;
    case "outbox.list": path = `/mail-outbox${input.taskId ? `?taskId=${encodeURIComponent(resource("taskId", /^t_[a-f0-9]{32}$/))}` : ""}`; break;
    case "outbox.draft": path = "/mail-outbox"; method = "POST"; break;
    case "outbox.confirm":
    case "outbox.cancel":
    case "outbox.resolve": path = `/mail-outbox/${resource("messageId", /^bm_[a-f0-9]{32}$/)}/${operation.split(".")[1]}`; method = "POST"; break;
    case "tasks.list": path = `/tasks?projectId=${encodeURIComponent(resource("projectId"))}`; break;
    case "tasks.all": path = "/tasks?scope=all"; break;
    case "tasks.get": path = `/tasks/${resource("taskId", /^t_[a-f0-9]{32}$/)}`; break;
    case "tasks.create": path = "/tasks"; method = "POST"; break;
    case "intake": path = "/intake"; method = "POST"; runtime = true; break;
    case "deliveries.list": path = "/deliveries"; break;
    case "deliveries.ack": path = "/deliveries/ack"; method = "POST"; resource("deliveryId"); break;
    case "audit.list": path = `/audit?since=${Number.isSafeInteger(input.since) && Number(input.since) >= 0 ? input.since : 0}`; break;
    default: {
      const action = /^tasks\.(claim|renew|result|accept|reject|cancel|release|close)$/.exec(operation)?.[1];
      if (!action) throw new Error("unsupported taskbus operation");
      path = `/tasks/${resource("taskId", /^t_[a-f0-9]{32}$/)}/${action}`; method = "POST";
      runtime = ["claim", "renew", "result"].includes(action);
    }
  }
  if (method === "POST" && operation !== "deliveries.ack") resource("requestKey");
  return { method, path, ...(method === "POST" ? { body: input } : {}), runtime };
}
