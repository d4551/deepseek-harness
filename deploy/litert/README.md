# LiteRT-LM inference server on Railway

English | [中文](README.zh.md)

This directory defines a Railway service that runs [LiteRT-LM](https://developers.google.com/edge/litert-lm/cli)'s OpenAI-compatible HTTP server. The harness reaches it through `@deepseek-ai/dsh-llm-litert` in its remote posture: the plugin registers the route's `baseURL` and model catalog on `ctx.llm` and supervises no local process.

## Files

| File | Role |
| --- | --- |
| `Dockerfile` | `python:3.12-slim` plus `pip install litert-lm`; carries no model layer and no model identity. |
| `entrypoint.sh` | Imports the configured model on first start, then runs `litert-lm serve --host 0.0.0.0 --port $PORT`. |
| `.railway/railway.ts` | Infrastructure as Code: the volume and its mount path, the model variables, the `/v1/models` health check, and one replica. |

Railway's `railway.json` Config as Code is deprecated — new services cannot opt into it, and existing files stop being read on 2026-12-01 — so this service is described by [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) instead. The difference is when the file is read: `railway.json` was read out of the repository during each deploy, while `.railway/railway.ts` is evaluated by the Railway CLI on your machine and applied on demand.

## Deploy steps

1. Connect your fork of this repository as a Railway service.
2. Set the service **Root Directory** to `deploy/litert`. That is what points Railway's builder at `Dockerfile` with this directory as the build context; nothing else in the repository is needed. `.railway/railway.ts` declares no `source`, so it manages settings without claiming ownership of the repository connection.
3. Apply the configuration from a checkout of `deploy/litert`:

   ```sh
   npm install railway
   railway login
   railway link
   railway config plan
   railway config apply
   ```

   `plan` prints the volume, variables, health check, and replica count it would set; `apply` performs them after confirmation. The CLI searches the current directory and its parents for `.railway/railway.ts`, so run it from `deploy/litert` or pass `--file`. Rename the project in the file to the one you linked, or `apply` renames it to match.

   Railway IaC otherwise reads a missing resource as a deleted one, so a whole-project file applied to an environment that holds anything else removes it. This file exports `partial = 'litert-lm'`, which limits that to the service and volume it declares; the rest of the linked environment is left alone. Do not rename the export after an apply — the old name keeps whatever it owned.
4. Edit the `LITERT_MODEL_*` values in `.railway/railway.ts` and re-apply if the default model is not the one you want.
5. Deploy. The first boot downloads and imports the model, so it takes far longer than later boots; `healthcheckTimeout` in `.railway/railway.ts` is sized for that, well above Railway's 300-second default.
6. Generate a public domain for the service. The harness route's `baseURL` is that domain plus `/v1`, for example `https://litert-production.up.railway.app/v1`.

Do not change the bind address or port in `entrypoint.sh`. Railway injects `PORT` and routes public traffic to it, so binding the CLI's own default port would leave the service unreachable and failing its health check.

## Environment variables

| Variable | Set by | Purpose |
| --- | --- | --- |
| `PORT` | Railway | The port `litert-lm serve --port` binds. The entrypoint fails loudly if it is missing. |
| `HOME` | Image and `.railway/railway.ts` (`/data`) | Selects the `litert-lm` registry directory (`$HOME/.litert-lm`). One `MOUNT_PATH` constant in `.railway/railway.ts` sets both this and the volume mount, so they cannot drift; the image bakes the same path for a plain `docker run`. |
| `LITERT_MODEL_REPO` | `.railway/railway.ts` | Hugging Face repository `litert-lm import --from-huggingface-repo` reads. The entrypoint fails loudly if it is missing. |
| `LITERT_MODEL_FILE` | `.railway/railway.ts` | The `.litertlm` file name inside that repository. The entrypoint fails loudly if it is missing. |
| `LITERT_MODEL_ID` | `.railway/railway.ts` | Registry id, which is also the `model` name the server answers to on `POST /v1/chat/completions` and the `models[].id` the harness route configures. The entrypoint fails loudly if it is missing. |

The image bakes no model identity, which is what makes those three guards able to fire: an image built from this `Dockerfile` refuses to start until a service supplies them. `HOME` carries no guard, because the image sets it and a container runtime always supplies one, so the guard could never fire; `packages/llm/llm-litert/tests/deploy.spec.ts` checks that agreement instead, along with the health check path and the bound port.

The server authenticates nothing: LiteRT-LM's HTTP API has no credential of its own. A public Railway domain therefore exposes an open inference endpoint. Keep the service private (internal networking only) or put an authenticating proxy in front of it if that is not acceptable.

## Model choice, memory, and volume sizing

The configuration defaults to `litert-community/gemma-4-E2B-it-litert-lm` (`gemma-4-E2B-it.litertlm`, registry id `gemma4-e2b`), the model Google's CLI documentation uses in its own examples. Point the three `LITERT_MODEL_*` variables at another `litert-community` repository to serve a different one; `litert-community/gemma-4-12B-it-litert-lm` (`gemma-4-12B-it.litertlm`) is the large end of the same family.

Two sizing consequences follow from the model you pick, and Google's CLI documentation does not publish per-model figures — read the file size from the Hugging Face repository's file listing before choosing an instance:

- **Volume.** The volume must hold the `.litertlm` file plus the CLI's disk cache. Size `sizeMB` to at least twice the file size; the shipped `4096` covers the default model on that rule. Railway's volume ceilings are 0.5 GB on Free and Trial plans, 5 GB on Hobby, and 50 GB on Pro, so a multi-gigabyte model needs at least a Hobby plan and a 12B-class model needs Pro. `volume()` also accepts a `region`; set it to the region the service runs in, or omit it as the shipped file does and let Railway place it.
- **Memory.** The server loads model weights into RAM on the CPU backend, so the instance needs memory on the order of the file size plus the KV cache for the context you serve. An instance smaller than the model file will be killed during startup and the deploy will fail its health check rather than serve slowly.

Only one replica may attach a volume, so `replicas` is `1`. Scaling this service means running more services, each with its own volume, behind whatever routes to them.

## Checking the deployment

```sh
curl https://<your-domain>/v1/models

curl https://<your-domain>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma4-e2b","messages":[{"role":"user","content":"Hello!"}]}'
```

`GET /v1/models` is also the health check path, so a service that answers the first command is a service Railway considers healthy and that `@deepseek-ai/dsh-llm-litert` can be pointed at.

## Wiring the harness to it

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-litert'
  config:
    provider: litert
    displayName: LiteRT on Railway
    baseURL: https://<your-domain>/v1
    models:
      - id: gemma4-e2b
        contextWindow: 32768
        maxTokens: 4096
```

The remote posture imports nothing, so both import instructions — `file` and `huggingFaceRepo` — are refused at load; the deployment above is where the model reaches a registry. Set `contextWindow` and `maxTokens` to the model's real capacities, because the harness sizes context management from them and no endpoint reports them.
