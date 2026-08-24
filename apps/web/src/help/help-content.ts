export type HelpModuleId =
  | 'connect-host'
  | 'status'
  | 'models'
  | 'modelfiles'
  | 'logs'
  | 'container-controls'
  | 'updates'
  | 'rollback'
  | 'audit';

export interface HelpModule {
  readonly id: HelpModuleId;
  readonly title: string;
  readonly eyebrow: string;
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly requires: readonly string[];
  readonly actions: readonly string[];
  readonly limits: readonly string[];
  readonly next: readonly HelpModuleId[];
}

export interface HelpWorkflow {
  readonly title: string;
  readonly summary: string;
  readonly modules: readonly HelpModuleId[];
}

export const HELP_MODULES: readonly HelpModule[] = [
  {
    id: 'connect-host',
    title: 'Connect an Ollama host',
    eyebrow: 'First-run setup',
    summary: 'Add an SSH host, verify its identity and select the Docker container that Ollama Remote Control should manage.',
    useWhen: [
      'You are configuring a server for the first time.',
      'No target is available yet and the dashboard asks you to connect a host.',
      'You need to bind Ollama Remote Control to a specific Ollama container on a host.',
    ],
    requires: [
      'SSH reachability from the ORC server to the Ollama host.',
      'The SSH username and private key for the host.',
      'Manual confirmation of the observed SSH host-key fingerprint.',
      'A Docker container running Ollama, or a container that can be discovered and selected.',
    ],
    actions: [
      'Probe and verify the SSH identity.',
      'Store the host connection after fingerprint confirmation.',
      'Discover Ollama-capable Docker containers.',
      'Select and name the target that ORC will operate on.',
    ],
    limits: [
      'Changing the hostname or port invalidates the previous fingerprint check.',
      'The private key is cleared from the browser after use.',
      'A target must be selected explicitly; discovery does not grant mutation authority by itself.',
    ],
    next: ['status', 'models'],
  },
  {
    id: 'status',
    title: 'Status dashboard',
    eyebrow: 'Read-only overview',
    summary: 'Check whether the selected container and Ollama service are healthy and whether GPU and model storage telemetry look normal.',
    useWhen: [
      'You want a quick health check before changing anything.',
      'Ollama requests are slow, unavailable or unexpectedly restarting.',
      'You need to verify GPU load, VRAM use, storage use or OLLAMA_* environment values.',
    ],
    requires: [
      'A configured target.',
      'SSH and Docker access for the selected host.',
    ],
    actions: [
      'Read container state, image, health, restart count and start time.',
      'Read the Ollama version and reported OLLAMA_* environment values.',
      'Inspect optional GPU telemetry such as utilization, VRAM and temperature.',
      'Inspect the model-storage mount and disk utilization.',
    ],
    limits: [
      'GPU and storage telemetry are optional and may show as unavailable without making the target unusable.',
      'This module is diagnostic only; it does not restart, update or modify the target.',
    ],
    next: ['logs', 'container-controls', 'models', 'updates'],
  },
  {
    id: 'models',
    title: 'Models',
    eyebrow: 'Ollama administration',
    summary: 'Inspect installed and running models, pull models, view details, unload active models and create models from Modelfiles.',
    useWhen: [
      'You want to see which models are installed or currently loaded.',
      'You need model metadata, size, quantization, context information or VRAM use.',
      'You want to pull, unload or create a model through the controlled Ollama API path.',
    ],
    requires: [
      'A configured target with its Ollama container running.',
      'The Ollama API must be reachable server-side through the pinned SSH path.',
    ],
    actions: [
      'Refresh the installed and running model inventory.',
      'Inspect model details and running-model state.',
      'Pull a model from an Ollama-compatible registry.',
      'Unload a running model after the server validates the operation.',
      'Create a model from a Modelfile workflow.',
    ],
    limits: [
      'Port 11434 remains private; the browser never talks to Ollama directly.',
      'Mutations are serialized against other target mutations.',
      'Model availability still depends on the target Ollama version, storage and registry/network access.',
    ],
    next: ['modelfiles', 'status', 'logs'],
  },
  {
    id: 'modelfiles',
    title: 'Modelfiles',
    eyebrow: 'Model definitions',
    summary: 'Work with reusable Modelfile definitions and portability workflows instead of editing model configuration ad hoc on the server.',
    useWhen: [
      'You want to define a custom model based on another model.',
      'You need repeatable parameters, system prompts or adapters captured in a Modelfile.',
      'You want to move or reuse a model definition between environments.',
    ],
    requires: [
      'A valid Modelfile definition.',
      'A compatible base model and any referenced resources available to the target when creating the model.',
    ],
    actions: [
      'Create and manage local Modelfile definitions in the Models administration workspace.',
      'Use a Modelfile as the source for controlled model creation.',
      'Use portability tools to preserve or transfer reusable model definitions.',
    ],
    limits: [
      'A Modelfile describes a model; it does not guarantee that referenced base models or artifacts exist on every target.',
      'Runtime compatibility is ultimately validated by Ollama on the selected target.',
    ],
    next: ['models', 'status'],
  },
  {
    id: 'logs',
    title: 'Live container logs',
    eyebrow: 'Read-only stream',
    summary: 'Follow stdout and stderr from the selected Ollama container through the existing server-side SSH connection.',
    useWhen: [
      'The status overview shows a problem but does not explain the cause.',
      'A model pull, load or request behaves unexpectedly.',
      'You need to observe startup, runtime or failure messages while reproducing an issue.',
    ],
    requires: [
      'A configured target and a selected container.',
      'The remote Docker log stream must be available through the pinned SSH connection.',
    ],
    actions: [
      'Choose a bounded tail size and connect to the log stream.',
      'Follow stdout and stderr in real time.',
      'Pause automatic scrolling, clear the browser view or disconnect explicitly.',
    ],
    limits: [
      'The module is read-only and does not provide an interactive shell.',
      'Disconnecting the browser stream cancels the remote follow process.',
      'The browser keeps only a bounded set of log entries.',
    ],
    next: ['status', 'container-controls', 'audit'],
  },
  {
    id: 'container-controls',
    title: 'Container controls',
    eyebrow: 'Controlled mutation',
    summary: 'Start, stop or restart the selected Ollama container using fixed server-side Docker operations.',
    useWhen: [
      'The Ollama container is stopped and should be started.',
      'A restart is needed after configuration or runtime problems.',
      'You intentionally need to stop the Ollama workload.',
    ],
    requires: [
      'A configured target bound to a specific container.',
      'Docker mutation access through the server-side SSH connection.',
      'Explicit confirmation for interruptive actions when requested.',
    ],
    actions: [
      'Start a stopped container.',
      'Stop or restart the bound container after explicit confirmation.',
      'Verify the resulting container state before success is reported.',
    ],
    limits: [
      'Stop and restart can interrupt active Ollama requests.',
      'The browser cannot submit arbitrary Docker commands.',
      'Operations are fixed and server-authoritative for the selected target.',
    ],
    next: ['status', 'logs', 'audit'],
  },
  {
    id: 'updates',
    title: 'Container updates',
    eyebrow: 'Validated Compose update',
    summary: 'Prepare, review and execute a controlled Ollama container update when the target can be validated as a Docker Compose service.',
    useWhen: [
      'You want to update the Ollama container image safely.',
      'You need to review the exact update plan before any mutation occurs.',
      'You want a server-generated rollback boundary captured before execution.',
    ],
    requires: [
      'The selected target must resolve to a server-validated Docker Compose project and service.',
      'The update preflight, snapshot, plan and strategy must all pass server validation.',
      'Explicit operator confirmation before execution.',
    ],
    actions: [
      'Capture a preflight snapshot.',
      'Build and review the proposed update plan and Compose strategy.',
      'Create a short-lived execution intent and confirm the target name and rollback boundary.',
      'Execute the validated update and verify the resulting state.',
    ],
    limits: [
      'Standalone container reconstruction is intentionally not executable in the 0.1 beta update path.',
      'A plan can be blocked if the Compose strategy, target binding or preflight evidence is not valid.',
      'Updates are mutating operations and can interrupt Ollama workloads.',
    ],
    next: ['status', 'logs', 'rollback', 'audit'],
  },
  {
    id: 'rollback',
    title: 'Manual rollback',
    eyebrow: 'Controlled recovery',
    summary: 'Revert a target using only the authenticated rollback authority preserved by the last successful managed update.',
    useWhen: [
      'A managed container update succeeded technically but the new version should be reverted.',
      'Post-update checks show a regression and a valid rollback candidate is available.',
    ],
    requires: [
      'A previous successful managed update for the same target.',
      'Persisted update intent, authenticated encrypted snapshot and exact image digests.',
      'The current target binding must still match the update history.',
      'Explicit operator confirmation before rollback execution.',
    ],
    actions: [
      'Validate whether rollback authority is still available.',
      'Review the server-derived rollback candidate.',
      'Execute the rollback after confirmation and refresh the target state.',
    ],
    limits: [
      'ORC will not invent a rollback target from tags or operator input.',
      'Rollback is unavailable if the target binding changed or no authenticated successful update exists.',
      'Ambiguous mutation failures are never retried automatically.',
    ],
    next: ['status', 'logs', 'audit'],
  },
  {
    id: 'audit',
    title: 'Audit history',
    eyebrow: 'Operator trace',
    summary: 'Review who performed operational actions, against which target, and whether those actions succeeded or failed.',
    useWhen: [
      'You need to understand what changed before a problem appeared.',
      'You want to trace operator actions or failed operations.',
      'You need a filtered JSON or CSV export for review or evidence.',
    ],
    requires: [
      'An authenticated ORC session.',
      'Audit events already recorded by server-side operations.',
    ],
    actions: [
      'Filter events by target, actor, action, result and time range.',
      'Inspect job, host, exit-code and error information.',
      'Export the filtered audit history as JSON or CSV.',
    ],
    limits: [
      'Sensitive parameters are redacted server-side before persistence and defensively redacted again for display/export.',
      'The audit view describes ORC operations; it is not a full host or Docker daemon audit log.',
    ],
    next: ['status', 'logs'],
  },
];

export const HELP_WORKFLOWS: readonly HelpWorkflow[] = [
  {
    title: 'Connect a new server',
    summary: 'Establish trust, select the Ollama container, then verify that the target is healthy.',
    modules: ['connect-host', 'status'],
  },
  {
    title: 'Troubleshoot Ollama',
    summary: 'Start with health telemetry, then use live logs to find the concrete failure before changing anything.',
    modules: ['status', 'logs', 'container-controls'],
  },
  {
    title: 'Add or customize a model',
    summary: 'Use Models for inventory and pulls; use Modelfiles when the model needs a reusable custom definition.',
    modules: ['models', 'modelfiles'],
  },
  {
    title: 'Update safely',
    summary: 'Review the validated Compose update plan, verify the new state, and keep rollback available if needed.',
    modules: ['updates', 'status', 'rollback', 'audit'],
  },
];

export function helpModule(id: HelpModuleId): HelpModule {
  const module = HELP_MODULES.find((candidate) => candidate.id === id);
  if (!module) throw new Error(`Unknown help module: ${id}`);
  return module;
}
