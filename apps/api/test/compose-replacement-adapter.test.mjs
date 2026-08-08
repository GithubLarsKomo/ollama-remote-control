import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { replaceComposeServiceImage } from '@orc/docker/compose-replacement';
import { execPrivateKey, probeHostKey } from '@orc/ssh';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH);

const CANDIDATE_DIGEST = `sha256:${'a'.repeat(64)}`;
const ROLLBACK_DIGEST = `sha256:${'b'.repeat(64)}`;
const CANDIDATE_REF = `ollama/ollama@${CANDIDATE_DIGEST}`;
const ROLLBACK_REF = `ollama/ollama@${ROLLBACK_DIGEST}`;
const CANDIDATE_IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const ROLLBACK_IMAGE_ID = `sha256:${'d'.repeat(64)}`;
const REMOTE_STUB = '/tmp/orc-compose-replacement-docker';
const REMOTE_LOG = '/tmp/orc-compose-replacement-calls';
const REMOTE_STDIN_LOG = '/tmp/orc-compose-replacement-stdin';
const REMOTE_CONTAINER = '/tmp/orc-compose-replacement-container';
const REMOTE_IMAGE_REF = '/tmp/orc-compose-replacement-image-ref';
const REMOTE_IMAGE_ID = '/tmp/orc-compose-replacement-image-id';

const context = {
  projectName: 'orc-stack',
  service: 'ollama',
  workingDirectory: '/srv/orc',
  configFiles: ['/srv/orc/compose.yml'],
  environmentFiles: [],
};

async function connection() {
  const observed = await probeHostKey({ hostname: SSH_HOST, port: SSH_PORT });
  return {
    hostname: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USER,
    privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
    expectedFingerprint: observed.fingerprint,
  };
}

function stubScript() {
  return `#!/usr/bin/env bash
set -euo pipefail
CANDIDATE_REF='${CANDIDATE_REF}'
ROLLBACK_REF='${ROLLBACK_REF}'
CANDIDATE_IMAGE_ID='${CANDIDATE_IMAGE_ID}'
ROLLBACK_IMAGE_ID='${ROLLBACK_IMAGE_ID}'
LOG='${REMOTE_LOG}'
STDIN_LOG='${REMOTE_STDIN_LOG}'
CONTAINER='${REMOTE_CONTAINER}'
IMAGE_REF='${REMOTE_IMAGE_REF}'
IMAGE_ID='${REMOTE_IMAGE_ID}'
printf 'docker %s\\n' "$*" >> "$LOG"

if [[ "${'$'}{1:-}" == 'image' && "${'$'}{2:-}" == 'pull' ]]; then
  [[ "${'$'}{3:-}" == "$CANDIDATE_REF" ]] || { printf 'only exact candidate pull allowed\\n' >&2; exit 64; }
  printf 'pulled exact candidate\\n'
  exit 0
fi

if [[ "${'$'}{1:-}" == 'image' && "${'$'}{2:-}" == 'inspect' ]]; then
  ref="${'$'}{3:-}"
  if [[ "$ref" == "$CANDIDATE_REF" ]]; then image_id="$CANDIDATE_IMAGE_ID";
  elif [[ "$ref" == "$ROLLBACK_REF" ]]; then image_id="$ROLLBACK_IMAGE_ID";
  else printf 'unknown exact image\\n' >&2; exit 1; fi
  printf '[{"Id":"%s","RepoDigests":["docker.io/%s"]}]\\n' "$image_id" "$ref"
  exit 0
fi

if [[ "${'$'}{1:-}" == 'compose' ]]; then
  [[ "${'$'}{2:-}" == '-p' && "${'$'}{3:-}" == 'orc-stack' && "${'$'}{4:-}" == '--project-directory' && "${'$'}{5:-}" == '/srv/orc' && "${'$'}{6:-}" == '-f' && "${'$'}{7:-}" == '/srv/orc/compose.yml' ]] || { printf 'bad compose context\\n' >&2; exit 64; }

  if [[ "${'$'}{8:-}" == '-f' && "${'$'}{9:-}" == '-' && "${'$'}{10:-}" == 'config' && "${'$'}{11:-}" == '--images' && "${'$'}{12:-}" == 'ollama' ]]; then
    payload="$(cat)"
    printf 'config:%s\\n' "$payload" >> "$STDIN_LOG"
    if [[ "$payload" == *"$CANDIDATE_REF"* ]]; then printf 'docker.io/%s\\n' "$CANDIDATE_REF";
    elif [[ "$payload" == *"$ROLLBACK_REF"* ]]; then printf 'docker.io/%s\\n' "$ROLLBACK_REF";
    else printf 'unexpected config override\\n' >&2; exit 64; fi
    exit 0
  fi

  if [[ "${'$'}{8:-}" == '-f' && "${'$'}{9:-}" == '-' && "${'$'}{10:-}" == 'up' ]]; then
    [[ "${'$'}{11:-}" == '-d' && "${'$'}{12:-}" == '--no-deps' && "${'$'}{13:-}" == '--force-recreate' && "${'$'}{14:-}" == '--pull' && "${'$'}{15:-}" == 'never' && "${'$'}{16:-}" == '--no-build' && "${'$'}{17:-}" == 'ollama' ]] || { printf 'unsafe compose up flags\\n' >&2; exit 64; }
    payload="$(cat)"
    printf 'up:%s\\n' "$payload" >> "$STDIN_LOG"
    if [[ "$payload" == *"$CANDIDATE_REF"* ]]; then
      printf 'candidate-container-id' > "$CONTAINER"
      printf '%s' "$CANDIDATE_REF" > "$IMAGE_REF"
      printf '%s' "$CANDIDATE_IMAGE_ID" > "$IMAGE_ID"
    elif [[ "$payload" == *"$ROLLBACK_REF"* ]]; then
      printf 'rollback-container-id' > "$CONTAINER"
      printf '%s' "$ROLLBACK_REF" > "$IMAGE_REF"
      printf '%s' "$ROLLBACK_IMAGE_ID" > "$IMAGE_ID"
    else printf 'unexpected up override\\n' >&2; exit 64; fi
    exit 0
  fi

  if [[ "${'$'}{8:-}" == 'ps' && "${'$'}{9:-}" == '--all' && "${'$'}{10:-}" == '-q' && "${'$'}{11:-}" == 'ollama' ]]; then
    cat "$CONTAINER"
    printf '\\n'
    exit 0
  fi
  printf 'unsupported compose command\\n' >&2
  exit 64
fi

if [[ "${'$'}{1:-}" == 'inspect' ]]; then
  id="${'$'}{2:-}"
  current="$(cat "$CONTAINER")"
  [[ "$id" == "$current" ]] || { printf 'unknown container\\n' >&2; exit 1; }
  ref="$(cat "$IMAGE_REF")"
  image_id="$(cat "$IMAGE_ID")"
  printf '[{"Id":"%s","Image":"%s","Config":{"Image":"docker.io/%s"},"State":{"Running":true}}]\\n' "$id" "$image_id" "$ref"
  exit 0
fi

printf 'unsupported docker command\\n' >&2
exit 64
`;
}

async function installStub(conn) {
  const setup = await execPrivateKey(
    conn,
    ['bash', '-c', `cat > ${REMOTE_STUB}; chmod 700 ${REMOTE_STUB}; : > ${REMOTE_LOG}; : > ${REMOTE_STDIN_LOG}; printf 'old-container-id' > ${REMOTE_CONTAINER}; : > ${REMOTE_IMAGE_REF}; : > ${REMOTE_IMAGE_ID}`],
    { stdin: stubScript(), maxInputBytes: 64 * 1024, timeoutMs: 10_000 },
  );
  assert.equal(setup.exitCode, 0);
}

async function readRemote(conn, path) {
  const result = await execPrivateKey(conn, ['cat', path], { timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0);
  return result.stdout;
}

async function cleanup(conn) {
  await execPrivateKey(conn, ['rm', '-f', REMOTE_STUB, REMOTE_LOG, REMOTE_STDIN_LOG, REMOTE_CONTAINER, REMOTE_IMAGE_REF, REMOTE_IMAGE_ID], { timeoutMs: 10_000 });
}

function composeCommandVerb(line) {
  const tokens = line.trim().split(/\s+/u);
  if (tokens[0] !== 'docker' || tokens[1] !== 'compose') return null;
  let index = 2;
  while (index < tokens.length) {
    if (tokens[index] === '-p' || tokens[index] === '--project-directory' || tokens[index] === '--env-file' || tokens[index] === '-f') {
      index += 2;
      continue;
    }
    return tokens[index] ?? null;
  }
  return null;
}

test('OpenSSH adapter performs exact forward replacement then local-only rollback with no rollback pull', { skip: !HAS_FIXTURE }, async () => {
  const conn = await connection();
  await installStub(conn);
  const executor = {
    exec: (argv, stdin) => execPrivateKey(
      conn,
      [REMOTE_STUB, ...argv.slice(1)],
      { stdin, maxInputBytes: 64 * 1024, maxOutputBytes: 512 * 1024, timeoutMs: 20_000 },
    ),
  };
  try {
    const forward = await replaceComposeServiceImage(
      executor, context, CANDIDATE_REF, 'old-container-id', 'pull-exact',
    );
    assert.equal(forward.containerId, 'candidate-container-id');
    assert.equal(forward.imageId, CANDIDATE_IMAGE_ID);

    const rollback = await replaceComposeServiceImage(
      executor, context, ROLLBACK_REF, forward.containerId, 'local-only',
    );
    assert.equal(rollback.containerId, 'rollback-container-id');
    assert.equal(rollback.imageId, ROLLBACK_IMAGE_ID);

    const calls = (await readRemote(conn, REMOTE_LOG)).trim().split(/\r?\n/u).filter(Boolean);
    assert.equal(calls.filter((line) => line.startsWith('docker image pull ')).length, 1);
    assert.equal(calls.includes(`docker image pull ${CANDIDATE_REF}`), true);
    assert.equal(calls.some((line) => line === `docker image pull ${ROLLBACK_REF}`), false);
    assert.equal(calls.filter((line) => line.includes(' up -d --no-deps --force-recreate --pull never --no-build ollama')).length, 2);
    assert.equal(calls.map(composeCommandVerb).some((verb) => verb === 'down' || verb === 'build'), false);

    const stdinLog = await readRemote(conn, REMOTE_STDIN_LOG);
    assert.equal(stdinLog.includes(CANDIDATE_DIGEST), true);
    assert.equal(stdinLog.includes(ROLLBACK_DIGEST), true);
    assert.equal((stdinLog.match(/^up:/gmu) ?? []).length, 2);
  } finally {
    await cleanup(conn);
  }
});
