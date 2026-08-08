import type { DockerDiscoveryResult } from '@orc/docker';

export interface PublicDockerDiscoveryCandidate {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly ports: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly inspect: {
    readonly image: string;
    readonly running: boolean;
    readonly mountCount: number;
    readonly portBindingCount: number;
    readonly labelCount: number;
  };
}

export interface PublicDockerDiscoveryResult {
  readonly dockerVersion: string;
  readonly candidates: readonly PublicDockerDiscoveryCandidate[];
  readonly recommendedContainerId: string | null;
  readonly ambiguous: boolean;
}

export function publicDockerDiscovery(result: DockerDiscoveryResult): PublicDockerDiscoveryResult {
  return {
    dockerVersion: result.dockerVersion,
    recommendedContainerId: result.recommendedContainerId,
    ambiguous: result.ambiguous,
    candidates: result.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      image: candidate.image,
      state: candidate.state,
      status: candidate.status,
      ports: candidate.ports,
      score: candidate.score,
      reasons: candidate.reasons,
      inspect: {
        image: candidate.inspect.image,
        running: candidate.inspect.running,
        mountCount: candidate.inspect.mounts.length,
        portBindingCount: Object.keys(candidate.inspect.portBindings).length,
        labelCount: Object.keys(candidate.inspect.labels).length,
      },
    })),
  };
}
