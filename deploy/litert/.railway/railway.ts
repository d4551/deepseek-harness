/**
 * Railway Infrastructure as Code for the LiteRT-LM inference service defined by
 * the sibling `Dockerfile` and `entrypoint.sh`.
 *
 * This file replaces the deprecated `railway.json` Config as Code: new services
 * cannot opt into that mechanism at all, and existing files stop being read on
 * 2026-12-01. Unlike `railway.json`, this file is not read during a deploy —
 * the Railway CLI evaluates it locally, compares it with the linked
 * environment, and applies the difference after confirmation
 * (`railway config plan`, then `railway config apply`, with `npm install
 * railway` for the `railway/iac` module). This repository declares that same
 * package, so `deploy/litert/tsconfig.json` compiles this file against the
 * declarations the CLI will evaluate it with, rather than leaving a rejected
 * call to surface at apply time.
 *
 * `source` is deliberately absent so this file owns service settings without
 * declaring a repository: connect your own fork in the Railway dashboard and
 * set the service Root Directory to `deploy/litert`, which is also what points
 * Railway's builder at the sibling `Dockerfile`.
 *
 * @module deploy/litert/railway
 */

import { defineRailway, project, service, volume } from 'railway/iac'

/**
 * Name that scopes this file's ownership inside the linked environment.
 *
 * Railway IaC otherwise treats omission as deletion: a whole-project file is
 * the complete desired state, so `railway config apply` removes every resource
 * the linked environment holds and the file does not name. This file describes
 * one service, and the environment it is applied to belongs to whoever deploys
 * it, so without a partial an apply would delete their unrelated resources.
 * With it, omit=delete reaches only the two resources below.
 *
 * This is the shape Railway's own `railway config migrate --service <name>`
 * writes, because the `railway.json` this file replaced was per-service.
 * The value is applied state: renaming it after an apply orphans what the old
 * name owned.
 */
export const partial = 'litert-lm'

/**
 * Container path the model volume is mounted at. The `litert-lm` CLI resolves
 * its registry as `$HOME/.litert-lm`, so the same constant is the service's
 * `HOME`: one value drives the mount and the registry directory, and neither
 * can drift from the other. `deploy/litert/Dockerfile` bakes the same path as
 * `ENV HOME` for a plain `docker run`, and the `@deepseek-ai/dsh-llm-litert`
 * deploy suite fails when the two disagree.
 */
const MOUNT_PATH = '/data'

/**
 * Volume size. The volume holds the `.litertlm` file plus the CLI's disk cache,
 * which the README sizes at twice the file size; 4 GB covers the default
 * `gemma-4-E2B-it` model on that rule and stays under Railway's 5 GB Hobby
 * ceiling. A 12B-class model needs a Pro plan, whose ceiling is 50 GB.
 */
const VOLUME_SIZE_MB = 4096

/**
 * Seconds Railway waits for the first successful health check. First boot
 * downloads and imports a multi-gigabyte model before the server listens, so
 * this is far above Railway's 300-second default; later boots find the model on
 * the volume and answer immediately.
 */
const HEALTHCHECK_TIMEOUT_SECONDS = 900

/**
 * Desired state this file owns inside the linked Railway project. Rename the
 * project to the one you linked with `railway link`, or `railway config apply`
 * renames it to match this file; the `partial` export above keeps the apply
 * from touching resources this file never created.
 * @returns the project graph `railway config plan` compares with the linked environment.
 */
export default defineRailway(() => {
  // No `region`: Railway provisions a volume in the region of the service that
  // mounts it, and both this volume and the service below therefore land in
  // the deployer's own preferred region. Pinning one here without pinning the
  // same one on the service is the cross-region attach Railway migrates with
  // downtime. To place both deliberately, set `region` here and the matching
  // `replicas: { <region>: 1 }` on the service, using one of Railway's region
  // identifiers: `us-west2`, `us-east4-eqdc4a`, `europe-west4-drams3a`, or
  // `asia-southeast1-eqsg3a`.
  const models = volume('litert-models', { sizeMB: VOLUME_SIZE_MB })

  const litert = service('litert-lm', {
    healthcheck: '/v1/models',
    healthcheckTimeout: HEALTHCHECK_TIMEOUT_SECONDS,
    // A volume attaches to one replica. Scaling means more services, each with
    // its own volume, behind whatever routes to them.
    replicas: 1,
    volumeMounts: { [MOUNT_PATH]: models },
    // The model identity is deployment configuration, not image content: the
    // image bakes none of these three, so `entrypoint.sh` refuses to start
    // without them. Point them at another `litert-community` repository to
    // serve a different model.
    env: {
      HOME: MOUNT_PATH,
      LITERT_MODEL_REPO: 'litert-community/gemma-4-E2B-it-litert-lm',
      LITERT_MODEL_FILE: 'gemma-4-E2B-it.litertlm',
      LITERT_MODEL_ID: 'gemma4-e2b',
    },
  })

  return project('litert-lm', { resources: [litert, models] })
})
