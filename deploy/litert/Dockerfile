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
# HOME at the Railway volume mount is what makes imported models survive a
# deploy. Keep this in step with `deploy.requiredMountPath` in railway.json and
# with the volume's configured mount path.
ENV HOME=/data
ENV LITERT_MODEL_REPO=litert-community/gemma-4-E2B-it-litert-lm
ENV LITERT_MODEL_FILE=gemma-4-E2B-it.litertlm
ENV LITERT_MODEL_ID=gemma4-e2b

COPY entrypoint.sh /usr/local/bin/litert-entrypoint.sh
RUN chmod +x /usr/local/bin/litert-entrypoint.sh

# Railway injects PORT and routes public traffic to it; the 9379 CLI default
# would never receive a request.
CMD ["/usr/local/bin/litert-entrypoint.sh"]
