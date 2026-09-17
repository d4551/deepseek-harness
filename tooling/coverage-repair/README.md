---
description: "Review and reconstruct the coverage-toolchain source candidates and their verification evidence."
---

# Coverage toolchain source candidates

English | [中文](README.zh.md)

## Summary

Review the complete source changes for the runner, converter, compiler, runtime, and package-manager repairs. These candidates are not installed by the root dependency graph. Their unresolved checks are recorded in [status.json](status.json).

## Table of Contents

- [Reconstruct source](#reconstruct-source)
- [Review inputs](#review-inputs)
- [Dev Note](#dev-note)



## Reconstruct source

Use Python 3.12 or later, Git, and an official archive whose digest matches [manifest.json](manifest.json). The reconstruction command rejects an existing destination and verifies every changed or added input after applying the readable source patch. It does not build or install the candidate.

```sh
repair_dir=$(mktemp -d)
python3 tooling/coverage-repair/reconstruct.py pnpm /tmp/dsh-pnpm-12.4.2-source.tgz "$repair_dir/pnpm"
```

Select another source and its archive from the manifest to reconstruct that candidate. The manifest retains original local paths for provenance. Candidate dependency manifests also retain their measured paths; relocating those dependencies and reconciling their lockfiles remains part of integration.



## Review inputs

The [source patches](patches/) contain implementation, test, and build-input changes. The [package artifacts](artifacts/) preserve generated packages with their recorded hashes. The evidence directory contains the [historical planning archive](evidence/full-green-plan.tar.gz), its [file inventory](evidence/full-green-plan-files.json), and the [supporting evidence inventory](evidence/inputs.json). Historical reports preserve failed results and may describe intermediate states; the status record identifies the final consolidation state.

## Dev Note

The complete-green objective is unfinished. The consolidation preserves source work for review and commit; it does not certify release readiness or activate incomplete tooling.
