export type HostId = string;
export type OllamaTargetId = string;
export type JobId = string;

export interface RemoteExecRequest {
  readonly argv: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface RemoteExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal?: string;
}

export interface HostKeyObservation {
  readonly algorithm: string;
  readonly fingerprint: string;
}

export interface SSHTransportPort {
  probeHostKey(): Promise<HostKeyObservation>;
  exec(request: RemoteExecRequest): Promise<RemoteExecResult>;
}

export interface ApiHealthResponse {
  readonly status: 'ok';
  readonly service: 'ollama-remote-control-api';
  readonly version: string;
  readonly database: {
    readonly status: 'ok';
    readonly schemaVersion: number;
  };
}
