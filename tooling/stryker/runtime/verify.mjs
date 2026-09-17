import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const rootManifest = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(rootManifest.devDependencies['jsonc-parser'], undefined);
assert.deepEqual(Object.keys(rootManifest.patchedDependencies), ['@stryker-mutator/instrumenter@10.0.0', '@stryker-mutator/vitest-runner@10.0.0']);
assert.equal(rootManifest.overrides, undefined);
await assert.rejects(lstat('node_modules/jsonc-parser'), { code: 'ENOENT' });
const core = await realpath('node_modules/@stryker-mutator/core');
const requireFromCore = createRequire(path.join(core, 'package.json'));
const instrumenter = await realpath('node_modules/@stryker-mutator/instrumenter');
assert.equal(await realpath(requireFromCore.resolve('@stryker-mutator/instrumenter/package.json')), path.join(instrumenter, 'package.json'));
const runner = await realpath('node_modules/@stryker-mutator/vitest-runner');
const requireFromRunner = createRequire(path.join(runner, 'package.json'));
assert.equal(await realpath(requireFromRunner.resolve('@stryker-mutator/core/package.json')), path.join(core, 'package.json'));
assert.equal(await realpath('node_modules/.bin/stryker'), path.join(core, 'bin/stryker.js'));
const api = await realpath('node_modules/@stryker-mutator/api');
assert.equal(requireFromRunner.resolve('@stryker-mutator/api/core'), path.join(api, 'dist/src/core/index.js'));
assert.equal(requireFromCore.resolve('@stryker-mutator/api/core'), path.join(api, 'dist/src/core/index.js'));
const parserPath = requireFromCore.resolve('jsonc-parser');
const parserManifestPath = requireFromCore.resolve('jsonc-parser/package.json');
const ownedLink = path.resolve(core, '../../jsonc-parser');
assert.equal(await realpath(ownedLink), path.dirname(parserManifestPath));
const parser = requireFromCore('jsonc-parser');
const diagnostics = [];
const lock = parser.parse(await readFile('bun.lock', 'utf8'), diagnostics, { allowTrailingComma: true });
assert.deepEqual(diagnostics, []);
assert.equal(lock.packages['@stryker-mutator/core'][1].dependencies['jsonc-parser'], '^3.3.1');
assert.equal(lock.packages['jsonc-parser'][0], 'jsonc-parser@3.3.1');
const coreEntries = Object.entries(lock.packages).filter(([name]) => name === '@stryker-mutator/core' || name.endsWith('/@stryker-mutator/core'));
assert.equal(coreEntries.length, 1);
assert.match(coreEntries[0][1][0], /artifacts\/stryker-core-10\.0\.0-ts7-source-repair\.tgz$/);
const { readdir } = await import('node:fs/promises');
assert.deepEqual((await readdir('node_modules/.bun')).filter(name => name.startsWith('@stryker-mutator+core@')), [path.basename(path.resolve(core, '../../..'))]);

const { TSConfigPreprocessor } = await import(pathToFileURL(path.join(core, 'dist/src/sandbox/ts-config-preprocessor.js')));
const { Project } = await import(pathToFileURL(path.join(core, 'dist/src/fs/project.js')));
const { FileSystem } = await import(pathToFileURL(path.join(core, 'dist/src/fs/file-system.js')));
const { LoggerImpl } = await import(pathToFileURL(path.join(core, 'dist/src/logging/logger-impl.js')));
const { LoggingBackend } = await import(pathToFileURL(path.join(core, 'dist/src/logging/logging-backend.js')));
const fs = new FileSystem();
const logging = new LoggingBackend(process.stdout);
try {
  const configPath = path.resolve('tsconfig.json');
  const valid = '\uFEFF{ // owned parser\n "include": ["src/**/*.ts",], "__proto__":{"retained":true},}\n';
  await writeFile(configPath, valid);
  const project = new Project(fs, { [configPath]: { mutate: false } });
  const preprocessor = new TSConfigPreprocessor(new LoggerImpl('owned-parser-proof', logging), {
    inPlace: false, tsconfigFile: configPath,
  });
  await preprocessor.preprocess(project);
  const normalized = JSON.parse(await project.files.get(configPath).readContent());
  assert.deepEqual(normalized, JSON.parse('{"include":["src/**/*.ts"],"__proto__":{"retained":true}}'));
  assert.equal(await readFile(configPath, 'utf8'), valid);
  const invalidPath = path.resolve('invalid-tsconfig.json');
  const invalid = '{"include": []';
  await writeFile(invalidPath, invalid);
  const invalidProject = new Project(fs, { [invalidPath]: { mutate: false } });
  await assert.rejects(new TSConfigPreprocessor(new LoggerImpl('owned-parser-proof', logging), {
    inPlace: false, tsconfigFile: invalidPath,
  }).preprocess(invalidProject), /CloseBraceExpected/);
  assert.equal(await invalidProject.files.get(invalidPath).readContent(), invalid);
  console.log(JSON.stringify({ node: process.version, core, runner, api, coreEntries, parserPath, ownedLink, dependencyEdge: lock.packages['@stryker-mutator/core'][1].dependencies['jsonc-parser'], normalized, invalidRejected: true }));
} finally {
  fs.dispose();
  await logging.dispose();
}
