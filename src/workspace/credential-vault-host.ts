import { MacKeychainCredentialVault, CredentialVaultError, assertCredentialCall, credentialDeadline,
  type CredentialVault, type AsyncCredentialVault, type CredentialCall, type CredentialEntry, type CredentialStorageDescriptor,
  type CredentialVaultErrorCode } from "./credential-vault.js";
import { AsyncWindowsDpapiCredentialVault, isWindowsDesktopSidecarBuild } from "./windows-credential-vault.js";

/** Bridge the legacy synchronous SPI. Native Windows is composed through its async adapter only. */
export function adaptCredentialVault(vault: CredentialVault): AsyncCredentialVault {
  const invoke = async <T>(kind: CredentialVaultErrorCode, call: CredentialCall | undefined, run: () => T): Promise<T> => {
    assertCredentialCall(call);
    try { return run(); }
    catch (error) { throw error instanceof CredentialVaultError ? error : new CredentialVaultError(kind); }
  };
  return {
    get: (ref, call) => invoke("credential_unreadable", call, () => vault.get(ref)),
    set: (ref, key, call) => invoke("write_unconfirmed", call, () => vault.set(ref, key)),
    setMany: (entries, call) => invoke("write_unconfirmed", call, () => {
      if (vault.setMany) return vault.setMany(entries);
      for (const { ref, key } of entries) vault.set(ref, key);
    }),
    remove: (ref, call) => invoke("cleanup_unconfirmed", call, () => vault.remove(ref)),
  };
}

/** One lane for the Host's canonical vault namespace, shared by its stores, imports and resolves. */
export class QueuedCredentialVault implements AsyncCredentialVault {
  private tail = Promise.resolve();
  private readonly closing = new AbortController();
  private pending = 0;
  constructor(private readonly backend: AsyncCredentialVault, private readonly observe: (error?: CredentialVaultError) => void = () => {}) {}

  private run<T>(options: CredentialCall | undefined, action: (call: CredentialCall) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([options?.signal ?? credentialDeadline(), this.closing.signal]);
    if (this.pending >= 32 || signal.aborted) return Promise.reject(new CredentialVaultError("unavailable", undefined, true));
    this.pending++;
    let started = false;
    let drained: Promise<void> | undefined;
    const call: CredentialCall = { ...options, signal, retainUntilDrained: done => { drained = done; } };
    const result = this.tail.then(async () => {
      assertCredentialCall(call);
      started = true;
      try {
        const value = await action(call);
        this.observe();
        return value;
      } catch (error) {
        if (error instanceof CredentialVaultError) this.observe(error);
        throw error;
      }
    });
    this.tail = result.then(() => drained, () => drained).finally(() => { this.pending--; });
    return new Promise((resolve, reject) => {
      const abortQueued = () => { if (!started) reject(new CredentialVaultError("unavailable", undefined, true)); };
      signal.addEventListener("abort", abortQueued, { once: true });
      result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abortQueued));
    });
  }
  get(ref: string, call?: CredentialCall) { return this.run(call, options => this.backend.get(ref, options)); }
  set(ref: string, key: string, call?: CredentialCall) { return this.run(call, options => this.backend.set(ref, key, options)); }
  setMany(entries: readonly CredentialEntry[], call?: CredentialCall) { return this.run(call, options => this.backend.setMany(entries, options)); }
  remove(ref: string, call?: CredentialCall) { return this.run(call, options => this.backend.remove(ref, options)); }

  async close(): Promise<void> {
    this.closing.abort();
    // Termination was requested by the active worker adapter. If exit cannot be confirmed, the
    // persisted worker PID keeps its unconfirmed write protected from recovery cleanup.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.tail, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(timer); }
  }
}

interface VaultSelection {
  home?: string;
  hostPlatform?: NodeJS.Platform;
  arch?: string;
  /** Only the trusted Host composition/test fixture can supply a backend. */
  vault?: AsyncCredentialVault;
  descriptor?: CredentialStorageDescriptor;
  windows?: (home: string) => AsyncCredentialVault;
  /** In-process composition seam. RPC callers cannot supply launch evidence. */
  windowsLaunch?: { source?: string; desktopSidecar: boolean };
}

export function createHostCredentialStorage(options: VaultSelection) {
  // The launch source belongs to this Host. Children may inherit process.env.
  const launchSource = process.env.HARA_WORKSPACE_LAUNCH_SOURCE;
  delete process.env.HARA_WORKSPACE_LAUNCH_SOURCE;
  const platform = options.hostPlatform ?? process.platform, arch = options.arch ?? process.arch;
  const hostPlatform = platform === "darwin" || platform === "win32" || platform === "linux" ? platform : "other";
  const descriptor: CredentialStorageDescriptor = options.descriptor ? { ...options.descriptor } : {
    schemaVersion: 1, hostPlatform, arch, backend: "none", supported: false, state: "unsupported", reason: "platform_unsupported",
  };
  let backend = options.vault;
  if (!backend) {
    const windowsX64 = hostPlatform === "win32" && arch === "x64";
    const launch = options.windowsLaunch ?? {
      source: launchSource,
      desktopSidecar: isWindowsDesktopSidecarBuild(),
    };
    // The same sidecar binary may be copied to a managed CLI location. Its build
    // provenance alone does not opt a direct CLI invocation into the Desktop vault.
    if (windowsX64 && (!launch.desktopSidecar || launch.source !== "desktop-windows-v1")) {
      Object.assign(descriptor, { backend: "none", supported: false, state: "unsupported", reason: "windows_desktop_required" });
    } else if (hostPlatform === "darwin" || windowsX64) {
      Object.assign(descriptor, { backend: hostPlatform === "darwin" ? "macos-keychain" : "windows-dpapi",
        supported: true, state: "not_checked", reason: null });
      try {
        if (!options.home) throw new CredentialVaultError("unavailable", "host_binding_unavailable");
        backend = hostPlatform === "darwin" ? adaptCredentialVault(new MacKeychainCredentialVault(options.home))
          : (options.windows ?? (home => new AsyncWindowsDpapiCredentialVault(home)))(options.home);
      } catch (error) {
        descriptor.state = "unavailable";
        descriptor.reason = error instanceof CredentialVaultError ? error.reason ?? "backend_unavailable" : "backend_unavailable";
      }
    } else if (hostPlatform === "win32") descriptor.reason = "architecture_unsupported";
  }
  if (!backend) {
    const fail = async (): Promise<never> => { throw new CredentialVaultError(descriptor.supported ? "unavailable" : "unsupported", descriptor.reason ?? undefined, true); };
    backend = { get: fail, set: fail, setMany: fail, remove: fail };
  }
  const vault = new QueuedCredentialVault(backend, error => {
    if (!descriptor.supported || error?.code === "invalid_request" || error?.code === "unsupported") return;
    descriptor.state = error ? "unavailable" : "ready";
    descriptor.reason = error ? error.reason ?? (error.code === "access_denied" ? "access_denied" : "backend_unavailable") : null;
  });
  return { vault, descriptor: (): CredentialStorageDescriptor => ({ ...descriptor }) };
}
