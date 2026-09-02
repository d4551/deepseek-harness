# LiteRT-LM inference server on Railway

English | [中文](README.zh.md)

This directory defines a Railway service that runs [LiteRT-LM](https://developers.google.com/edge/litert-lm/cli)'s OpenAI-compatible HTTP server. The harness reaches it through `@deepseek-ai/dsh-llm-litert` in its remote posture: the plugin registers the route's `baseURL` and model catalog on `ctx.llm` and supervises no local process.

## Files

| File | Role |
| --- | --- |
| `Dockerfile` | `python:3.12-slim` plus `pip install litert-lm`; carries no model layer. |
| `entrypoint.sh` | Imports the configured model on first start, then runs `litert-lm serve --host 0.0.0.0 --port $PORT`. |
| `railway.json` | Build, start command, `/v1/models` health check, and the required volume mount path. |

## Deploy steps

1. Create a Railway service from this repository.
2. Set the service **Root Directory** to `deploy/litert`. Railway then reads `railway.json` and builds `Dockerfile` with this directory as the build context; nothing else in the repository is needed.
3. Create a volume on the service and set its mount path to `/data`. `railway.json` declares `deploy.requiredMountPath` as `/data`, and the image sets `HOME=/data` so the CLI's registry directory (`$HOME/.litert-lm`) lives on the volume. Without the volume the model is re-downloaded on every deploy.
4. Set the model variables below if the default model is not the one you want.
5. Deploy. The first boot downloads and imports the model, so it takes far longer than later boots; the health check budget in `railway.json` is sized for that.
6. Generate a public domain for the service. The harness route's `baseURL` is that domain plus `/v1`, for example `https://litert-production.up.railway.app/v1`.

Do not change the bind address or port in the start command. Railway injects `PORT` and routes public traffic to it, so binding the CLI's `9379` default would leave the service unreachable and failing its health check.

## Environment variables

| Variable | Set by | Purpose |
| --- | --- | --- |
| `PORT` | Railway | The port `litert-lm serve --port` binds. The entrypoint fails loudly if it is missing. |
| `RAILWAY_VOLUME_MOUNT_PATH` | Railway | Where the attached volume is mounted; keep it at `/data` so it matches `HOME`. |
| `HOME` | Image (`/data`) | Selects the `litert-lm` registry directory. Override it only together with the volume mount path. |
| `LITERT_MODEL_REPO` | Image / service | Hugging Face repository `litert-lm import --from-huggingface-repo` reads. |
| `LITERT_MODEL_FILE` | Image / service | The `.litertlm` file name inside that repository. |
| `LITERT_MODEL_ID` | Image / service | Registry id, which is also the `model` name the server answers to on `POST /v1/chat/completions` and the `models[].id` the harness route configures. |

The server authenticates nothing: LiteRT-LM's HTTP API has no credential of its own. A public Railway domain therefore exposes an open inference endpoint. Keep the service private (internal networking only) or put an authenticating proxy in front of it if that is not acceptable.

## Model choice, memory, and volume sizing

The image defaults to `litert-community/gemma-4-E2B-it-litert-lm` (`gemma-4-E2B-it.litertlm`, registry id `gemma4-e2b`), the model Google's CLI documentation uses in its own examples. Point the three `LITERT_MODEL_*` variables at another `litert-community` repository to serve a different one; `litert-community/gemma-4-12B-it-litert-lm` (`gemma-4-12B-it.litertlm`) is the large end of the same family.

Two sizing consequences follow from the model you pick, and Google's CLI documentation does not publish per-model figures — read the file size from the Hugging Face repository's file listing before choosing an instance:

- **Volume.** The volume must hold the `.litertlm` file plus the CLI's disk cache. Size it to at least twice the file size. Railway's volume ceilings are 0.5 GB on Free and Trial plans, 5 GB on Hobby, and 50 GB on Pro, so a multi-gigabyte model needs at least a Hobby plan and a 12B-class model needs Pro.
- **Memory.** The server loads model weights into RAM on the CPU backend, so the instance needs memory on the order of the file size plus the KV cache for the context you serve. An instance smaller than the model file will be killed during startup and the deploy will fail its health check rather than serve slowly.

Only one replica may attach a volume, so `deploy.numReplicas` is `1`. Scaling this service means running more services, each with its own volume, behind whatever routes to them.

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
        file: gemma-4-E2B-it.litertlm
        contextWindow: 32768
        maxTokens: 4096
```

`file` records which artifact the route serves; the remote posture imports nothing, so a `huggingFaceRepo` beside it is refused at load. Set `contextWindow` and `maxTokens` to the model's real capacities — the harness sizes context management from them, and no endpoint reports them.
