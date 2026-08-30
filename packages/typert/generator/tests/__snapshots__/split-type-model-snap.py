from pathlib import Path

source = Path(__file__).with_name('type-model.spec.ts.snap')
text = source.read_text()
header = '// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html\n\n'
marker = 'exports[`WorkspaceAnalyzer > builds independent face models with an explicit cross-face type graph 1`] = '
idx = text.find(marker)
if idx < 0:
    raise SystemExit('workspace snapshot key missing')
emitter = text[:idx].rstrip() + '\n'
if not emitter.startswith('//'):
    emitter = header + emitter
workspace = header + text[idx:]
Path(__file__).with_name('type-model-emitter.spec.ts.snap').write_text(emitter)
Path(__file__).with_name('type-model-workspace.spec.ts.snap').write_text(workspace)
print('wrote emitter and workspace snapshots')
