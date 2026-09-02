#!/bin/sh
# Import the configured model once, then serve it on Railway's injected port.
set -eu

: "${PORT:?PORT is injected by Railway and must be bound instead of the 9379 CLI default}"
: "${HOME:?HOME selects the litert-lm registry directory and must point at the mounted volume}"
: "${LITERT_MODEL_REPO:?LITERT_MODEL_REPO must name the Hugging Face repository to import from}"
: "${LITERT_MODEL_FILE:?LITERT_MODEL_FILE must name the .litertlm file inside that repository}"
: "${LITERT_MODEL_ID:?LITERT_MODEL_ID must name the registry id the server answers to}"

# The registry lives on the volume, so a redeploy finds the model already
# imported. `litert-lm list` prints one row per model with the id leading;
# a header row cannot collide with a configured id.
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
