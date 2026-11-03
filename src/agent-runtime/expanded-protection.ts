import type { RunOpts } from "../agent/loop.js";
import type { ExpandedRuntimeId } from "./expanded-models.js";
import type { NativeToolObservation } from "./expanded-protocol.js";

/** Host-only composition seam. A renderer or model cannot supply a protection function.
 * The common permission tier owns the OS wrapper; an absent layer must never launch full permissions. */
export interface ProtectedExpandedRuntime {
  readonly fullProtected: boolean;
  readonly temporaryDirectory: string;
  assertCurrent(): void;
  wrap(command: string, args: readonly string[], env: NodeJS.ProcessEnv): { command: string; args: string[]; env: NodeJS.ProcessEnv };
  observeNativeTool(event: NativeToolObservation): void;
  collectEvidence?(): void | Promise<void>;
  close(): Promise<void>;
}
export type ExpandedRuntimeProtection = (input: {
  runtimeId: ExpandedRuntimeId; options: RunOpts; command: string; env: NodeJS.ProcessEnv;
}) => Promise<ProtectedExpandedRuntime>;
// Optional trusted preflight runs before even model/help queries. Only Host composition supplies it.
export type PreflightExpandedRuntimeProtection = ExpandedRuntimeProtection & {
  assertLaunchSupported?(runtimeId: ExpandedRuntimeId): void;
};
export const unavailableExpandedProtection: ExpandedRuntimeProtection = async () => { throw new Error("runtime_permission_denied"); };
