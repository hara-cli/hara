import { VersionedSettings } from "./versioned-settings.js";
import { plain, exact } from "./local-state.js";
import { currentWorkspaceResourceBinding, sameWorkspaceResourceBinding, workspaceStateHome, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { normalizeRuntimeProxyUrl, runtimeProxyEnv, assertRuntimeProxyReachable, RuntimeProxyError } from "../security/runtime-proxy.js";

interface ProxySettings { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; proxyUrl: string | null }
/** One private, versioned document per Workspace resource generation. Never writes host network settings. */
export class WorkspaceRuntimeProxy {
  private readonly state: VersionedSettings<ProxySettings>;
  constructor(private readonly storage: WorkspaceResourceStorage) {
    const binding = () => storage.run(() => ({ ...currentWorkspaceResourceBinding()! }));
    this.state = new VersionedSettings(() => storage.run(() => workspaceStateHome()), "runtime-proxy-v1.json", 1,
      () => ({ schemaVersion: 1, revision: 0, resourceBinding: binding(), proxyUrl: null }), raw => {
        if (!plain(raw) || !exact(raw, ["schemaVersion", "revision", "resourceBinding", "proxyUrl"]) || raw.schemaVersion !== 1
          || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
          || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, binding())) throw new RuntimeProxyError("runtime_proxy_invalid");
        return { schemaVersion: 1, revision: Number(raw.revision), resourceBinding: binding(), proxyUrl: normalizeRuntimeProxyUrl(raw.proxyUrl) };
      }, {}, storage);
  }
  read() {
    try {
      const { value, readOnly } = this.state.read();
      return { revision: value.revision, proxyUrl: value.proxyUrl, readOnly };
    } catch { throw new RuntimeProxyError("runtime_proxy_invalid"); }
  }
  save(proxyUrl: unknown, expectedRevision: number) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid runtime proxy revision");
    const endpoint = normalizeRuntimeProxyUrl(proxyUrl);
    this.state.update(expectedRevision, value => ({ ...value, proxyUrl: endpoint }));
    return this.read();
  }
  apply(env: NodeJS.ProcessEnv) {
    const current = this.read();
    if (current.readOnly) throw new RuntimeProxyError("runtime_proxy_invalid");
    return runtimeProxyEnv(env, current.proxyUrl);
  }
  applyChecked(env: NodeJS.ProcessEnv, checked: { revision: number; proxyUrl: string | null }) {
    const latest = this.read();
    if (latest.readOnly) throw new RuntimeProxyError("runtime_proxy_invalid");
    if (latest.revision !== checked.revision || latest.proxyUrl !== checked.proxyUrl) throw new Error("Runtime proxy changed; retry explicitly");
    return runtimeProxyEnv(env, checked.proxyUrl);
  }
  async check(signal?: AbortSignal) {
    const current = this.read();
    if (current.readOnly) throw new RuntimeProxyError("runtime_proxy_invalid");
    await assertRuntimeProxyReachable(current.proxyUrl, signal);
    const latest = this.read();
    if (latest.readOnly) throw new RuntimeProxyError("runtime_proxy_invalid");
    if (latest.revision !== current.revision || latest.proxyUrl !== current.proxyUrl) throw new Error("Runtime proxy changed; retry explicitly");
    return current;
  }
}
