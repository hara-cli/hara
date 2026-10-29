import { probeExternalCommand, type ExternalCommandOptions } from "./process.js";
import {
  ExternalSessionInputError,
  type ExternalSessionAdapter,
  type ExternalSessionAdapterPage,
  type ExternalSessionReadResult,
  type ExternalSessionSourceInfo,
  type ExternalTurnResult,
  type ExternalTurnSink,
} from "./types.js";

const unavailable = (): never => {
  throw new ExternalSessionInputError("Antigravity external sessions require an official adapter");
};

/** Local CLI presence only; no native session format or write authority is assumed. */
export class AgyExternalSessionAdapter implements ExternalSessionAdapter {
  readonly id = "agy" as const;
  constructor(private readonly options: ExternalCommandOptions = { command: "agy" }) {}

  async inspect(): Promise<ExternalSessionSourceInfo> {
    const probe = await probeExternalCommand(this.options);
    return {
      id: this.id,
      label: "Antigravity",
      state: !probe.installed ? "not_installed" : probe.failed ? "error" : "adapter_required",
      ...(!probe.failed && probe.version ? { version: probe.version } : {}),
      reason: !probe.installed ? "command_not_found" : probe.failed ? "probe_failed" : "official_adapter_not_bundled",
      capabilities: { listMetadata: false, read: false, create: false, fork: false, resume: false,
        observeLive: false, submit: false, steer: false, interrupt: false },
    };
  }

  async list(): Promise<ExternalSessionAdapterPage> { return unavailable(); }
  async create(): Promise<ExternalSessionReadResult> { return unavailable(); }
  async read(): Promise<ExternalSessionReadResult> { return unavailable(); }
  async resume(): Promise<ExternalSessionReadResult> { return unavailable(); }
  async submit(_sessionId: string, _text: string, _sink: ExternalTurnSink): Promise<ExternalTurnResult> { return unavailable(); }
}
