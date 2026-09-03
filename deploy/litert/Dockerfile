# LiteRT-LM OpenAI-compatible inference server.
#
# The image carries only the CLI. The model itself is imported on first start
# into the mounted volume, never into an image layer: a `.litertlm` file is
# gigabytes, and a layer copy would be re-pulled on every deploy while the
# volume already holds it.
FROM python:3.12-slim

# `litert-lm import` downloads from Hugging Face over TLS.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The CLI requires Python 3.10 or higher; this base is 3.12.
RUN pip install --no-cache-dir --upgrade litert-lm

# The CLI keeps its model registry and caches in `$HOME/.litert-lm`, so pointing
# HOME at the volume mount is what makes imported models survive a deploy. The
# same path is `MOUNT_PATH` in `.railway/railway.ts`, which derives both the
# mount and the service's own HOME from it; the deploy suite in
# `packages/llm/llm-litert` fails when the two files disagree.
ENV HOME=/data

# Which model this serves is deployment configuration, not image content:
# `.railway/railway.ts` supplies LITERT_MODEL_REPO, LITERT_MODEL_FILE, and
# LITERT_MODEL_ID as service variables, so the image stays model-agnostic and
# the entrypoint's guards on them can actually fire.

COPY entrypoint.sh /usr/local/bin/litert-entrypoint.sh
RUN chmod +x /usr/local/bin/litert-entrypoint.sh

# Railway injects PORT and routes public traffic to it; the CLI's own default
# port would never receive a request.
CMD ["/usr/local/bin/litert-entrypoint.sh"]
