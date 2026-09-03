#!/bin/sh
# Import the configured model once, then serve it on Railway's injected port.
set -eu

# Every guard below names a variable no image layer sets: the platform injects
# PORT, and the model identity comes from the service variables in
# `.railway/railway.ts`. HOME carries no guard — the image bakes it and a
# container runtime always supplies one, so a guard on it could never fire.
: "${PORT:?PORT is injected by Railway and must be bound instead of the CLI default port}"
: "${LITERT_MODEL_REPO:?LITERT_MODEL_REPO must name the Hugging Face repository to import from}"
: "${LITERT_MODEL_FILE:?LITERT_MODEL_FILE must name the .litertlm file inside that repository}"
: "${LITERT_MODEL_ID:?LITERT_MODEL_ID must name the registry id the server answers to}"

# The registry lives on the volume, so a redeploy finds the model already
# imported. `litert-lm list` prints a `Listing models in: <dir>` preamble and a
# header row before one row per model with the id leading, so the leading words
# of those two lines also reach this match; neither can collide with a
# configured id without the server then failing loudly on the missing model.
if litert-lm list | awk '{print $1}' | grep -qx "${LITERT_MODEL_ID}"; then
  echo "litert: ${LITERT_MODEL_ID} is already in the registry under ${HOME}/.litert-lm"
else
  echo "litert: importing ${LITERT_MODEL_ID} from ${LITERT_MODEL_REPO}"
  litert-lm import \
    --from-huggingface-repo "${LITERT_MODEL_REPO}" \
    "${LITERT_MODEL_FILE}" \
    "${LITERT_MODEL_ID}"
fi

exec litert-lm serve --host 0.0.0.0 --port "${PORT}"
