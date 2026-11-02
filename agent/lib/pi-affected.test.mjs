import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { applyEdges, changedFiles, decide, HELP, install, loadConfig, main, parseToolOutput, renderSlnf, solutionProjects } from './pi-affected.mjs';

const stageNames = ['BodyWorker', 'Conformance.Specs', 'Contracts', 'Host', 'Rendering.Cratis.Scaffolding', 'Rendering.Cratis', 'Rendering.Declarative', 'Rendering.Kits', 'Rendering.Templates', 'SpecRunner', 'Specifications', 'Stage'];
const playNames = ['Screenplay.CanonicalCorpus', 'Screenplay.CanonicalVectors.Specs', 'Screenplay', 'Screenplay.Conformance', 'Screenplay.Contexts', 'Screenplay.Matching', 'Screenplay.Matching.Specs', 'Screenplay.Mcp', 'Tool', 'Screenplay.Contracts', 'Screenplay.ContractCatalog', 'Screenplay.ContractCatalog.Specs'];
const stage = name => `Source/${name}/${name}.csproj`;
const play = name => { const n = name === 'Tool' || name === 'Screenplay' ? name : `Screenplay.${name}`; return `Source/DotNET/${n}/${n}.csproj`; };
const defaults = new URL('./pi-affected-defaults.json', import.meta.url);
const root = resolve('ROOT');
const output = projects => `DRY-RUN: WRITE ${root}/affected.txt\nDRY-RUN: CONTENTS:\n${projects.map(p => `${root}/${p}`).join('\n')}\n\n`;
const fixture = (id, changed, selected, expected, rule, extra = {}) => ({ id, changed, selected, expected, rule, ...extra });
const fixtures = [
  fixture('stage seed-trans', ['Source/Contracts/Commands/AuthorizationRequirement.cs'], ['BodyWorker', 'Conformance.Specs', 'Contracts', 'Host', 'Rendering.Cratis.Scaffolding', 'Rendering.Cratis', 'Rendering.Declarative', 'SpecRunner', 'Specifications', 'Stage']),
  fixture('stage seed-hiddenedge', ['Source/SpecRunner/MissingArgument.cs'], ['SpecRunner'], ['SpecRunner', 'Host', 'Conformance.Specs']),
  fixture('stage seed-del', ['Source/Specifications/SemanticCaptureSources.cs'], ['Conformance.Specs', 'SpecRunner', 'Specifications'], ['Conformance.Specs', 'SpecRunner', 'Specifications', 'Host']),
  fixture('stage seed-ren', ['Source/Stage/Semantics/SemanticApplicationContext.cs', 'Source/Stage/Semantics/SemanticApplicationContextRenamed.cs'], ['Conformance.Specs', 'Host', 'SpecRunner', 'Specifications', 'Stage']),
  fixture('stage seed-json', ['Source/Rendering.Cratis/Shipped/ShippedPackages.json'], ['BodyWorker', 'Conformance.Specs', 'Rendering.Cratis.Scaffolding', 'Rendering.Cratis'], ['BodyWorker', 'Conformance.Specs', 'Rendering.Cratis.Scaffolding', 'Rendering.Cratis', 'Host']),
  fixture('stage hist06', ['Source/Rendering.Cratis/Semantics/AuthoringMetadataInput.cs', 'Source/Rendering.Cratis/for_AuthoringMetadataInput/when_creating_input_with_a_file_included_handler.cs'], ['Conformance.Specs', 'Rendering.Cratis.Scaffolding', 'Rendering.Cratis']),
  ...['global.json', 'Directory.Packages.props', 'Directory.Build.props', 'Source/Directory.Build.targets'].map(p => fixture(`stage build ${p}`, [p], null, 'full', 'build-input')),
  fixture('stage seed-ts', ['Source/Frontend/Runtime/styledPrimeReact.ts'], [], 'full', 'empty-selection'),
  fixture('stage hist01', ['Source/Conformance.Specs/for_SceneEnumerationNaming/scene-model-enumerations.json', 'Source/Frontend/Runtime/package.json', 'Source/Frontend/package-lock.json', 'Source/Frontend/package.json', 'Source/Rendering.Cratis/Scaffolding/CratisFrontendPackageSet.cs', 'Source/Rendering.Cratis/Scene/SceneEnumerationNaming.cs'], ['BodyWorker', 'Conformance.Specs', 'Host', 'Rendering.Cratis.Scaffolding', 'Rendering.Cratis', 'SpecRunner', 'Specifications', 'Stage'], 'full', 'unowned-non-cs', { paths: ['Source/Frontend/Runtime/package.json', 'Source/Frontend/package-lock.json', 'Source/Frontend/package.json'] }),
  fixture('stage hist05', ['.github/spec-shards.py', '.github/workflows/dotnet-build.yml', 'Directory.Packages.props', 'Documentation/docker/index.md'], null, 'full', 'build-input'),
  fixture('play seed-generator', ['Source/DotNET/Screenplay.ContractCatalog/ContractCatalogGenerator.cs'], ['CanonicalCorpus', 'CanonicalVectors.Specs', 'Conformance', 'ContractCatalog.Specs', 'ContractCatalog', 'Contracts', 'Mcp', 'Screenplay', 'Tool']),
  fixture('play seed-golden', ['Source/DotNET/Screenplay/Semantics/Serialization/Golden/full-esm-v1.json'], ['CanonicalCorpus', 'CanonicalVectors.Specs', 'Conformance', 'Contracts', 'Mcp', 'Screenplay', 'Tool']),
  fixture('play seed-trans', ['Source/DotNET/Screenplay.Contexts/Contexts/Causation.cs'], ['CanonicalCorpus', 'CanonicalVectors.Specs', 'Conformance', 'Contexts', 'Contracts', 'Mcp', 'Screenplay', 'Tool']),
  fixture('play seed-json', ['Source/Screenplay/Compiler/Conformance/portable-match-dialect.json'], ['Matching.Specs'], 'full', 'unowned-non-cs'),
  fixture('play hist09', ['Source/Screenplay/Monaco/screenplay-language/symbols.ts', 'Source/Screenplay/for_concepts/when_declaring_a_concept_with_a_keyword_modifier.ts'], [], 'full', 'empty-selection'),
  fixture('docs only', ['README.md', 'Documentation/docker/index.md'], [], 'none'),
  fixture('clean', [], null, 'none'),
  fixture('docs + selection', ['README.md'], ['Screenplay']),
  fixture('dir boundary', ['Source/DotNET/Screenplay.Mcp/x.json'], ['Screenplay'], 'full', 'unowned-non-cs'),
  fixture('stray .cs', ['Tools/Scratch.cs'], ['Screenplay']),
  fixture('tool error', ['Any.cs'], [], 'full', 'tool-error', { result: { exit: 1, stderr: 'first\nMSBuild evaluation failed\n' } }),
  ...['timeout', 'spawn error', 'unparseable'].map(id => fixture(id, ['Any.cs'], [], 'full', 'tool-error', { result: id === 'unparseable' ? { exit: 0, stdout: 'not a dry run' } : new Error(id) })),
  fixture('unavailable', ['Any.cs'], [], 'full', 'tool-unavailable', { unavailable: true }),
  fixture('config fullOnPaths', ['Source/Gen/x.yml'], null, 'full', 'build-input', { config: { fullOnPaths: ['Source/Gen/**'] } }),
];

for (const f of fixtures) test(`fixture: ${f.id}`, async () => {
  const isStage = f.id.startsWith('stage');
  const project = isStage ? stage : play;
  const projects = isStage ? stageNames.map(stage) : playNames.map(n => `Source/DotNET/${n}/${n}.csproj`);
  const config = f.config ?? loadConfig(defaults, '/nonexistent/pi-affected-config', isStage ? 'Cratis/Stage' : 'Cratis/Screenplay');
  let calls = 0;
  const result = await decide({ root, projects, changed: f.changed, config }, {
    install: () => { if (f.unavailable) throw new Error('install failed'); return 'fake'; },
    runTool: () => {
      calls++;
      assert.notEqual(f.selected, null, 'must not run the tool');
      if (f.result instanceof Error) throw f.result;
      return f.result ?? { exit: f.selected.length ? 0 : 166, stdout: f.selected.length ? output(f.selected.map(project)) : 'No affected projects where found for the current changes   \n' };
    },
  });
  assert.equal(result.mode, typeof f.expected === 'string' ? f.expected : 'selected');
  if (result.mode === 'selected') {
    assert.deepEqual(result.projects, (f.expected ?? f.selected).map(project).sort());
    assert.deepEqual(result.added.map(a => a.project).sort(), result.projects.filter(p => !f.selected.map(project).includes(p)));
    for (const edge of result.added) assert.ok(f.selected.map(project).includes(edge.because));
  }
  if (f.rule) assert.equal(result.reasons[0].rule, f.rule);
  if (f.paths) assert.deepEqual(result.reasons[0].paths, f.paths);
  if (f.id === 'tool error') assert.match(result.reasons[0].detail, /1.*MSBuild evaluation failed/);
  if (f.selected === null) assert.equal(calls, 0);
});

test('parseToolOutput handles dry run, exit 166, and missing marker', () => {
  assert.deepEqual(parseToolOutput(output([stage('SpecRunner')]), 0, root), [stage('SpecRunner')]);
  assert.deepEqual(parseToolOutput('No affected projects where found for the current changes   \n', 166, root), []);
  assert.throws(() => parseToolOutput('no marker', 0, root));
});

test('solutionProjects preserves original sln entries and renderSlnf sorts them', () => {
  assert.deepEqual(solutionProjects('<Solution><Project Path="A/A.csproj"/><Project Path="B/B.csproj" /></Solution>', '.slnx'), ['A/A.csproj', 'B/B.csproj']);
  const entries = solutionProjects('Project("{X}") = "B", "B\\B.csproj", "{Y}"\nProject("{X}") = "A", "A\\A.csproj", "{Z}"', '.sln');
  assert.deepEqual(entries, ['B\\B.csproj', 'A\\A.csproj']);
  assert.deepEqual(JSON.parse(renderSlnf(join(root, 'Toy.sln'), join(root, 'out', 'x.slnf'), entries)), { solution: { path: '../Toy.sln', projects: ['A\\A.csproj', 'B\\B.csproj'] } });
});

test('applyEdges reaches a fixpoint and notes missing targets', () => {
  const result = applyEdges(['A'], { A: ['B'], B: ['C', 'Missing'], C: ['A'] }, new Set(['A', 'B', 'C']));
  assert.deepEqual(result.projects, ['A', 'B', 'C']);
  assert.deepEqual(result.added, [{ project: 'B', because: 'A' }, { project: 'C', because: 'B' }]);
  assert.match(result.notes[0], /Missing/);
});

test('loadConfig replaces each repo entry, validates types and allows missing user file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-affected-config-'));
  const user = join(dir, 'user.json');
  writeFileSync(user, JSON.stringify({ schema: 1, repos: { 'Cratis/Stage': { ignorePaths: ['Frontend/**'] } } }));
  assert.deepEqual(loadConfig(defaults, user, 'Cratis/Stage'), { ignorePaths: ['Frontend/**'] });
  for (const entry of [{ unknown: [] }, { edges: [] }, { edges: { A: 'B' } }, { note: 1 }, { ignorePaths: [1] }, { fullOnPaths: 'x' }]) {
    writeFileSync(user, JSON.stringify({ schema: 1, repos: { X: entry } }));
    assert.throws(() => loadConfig(defaults, user, 'X'));
  }
  writeFileSync(user, '{');
  assert.throws(() => loadConfig(defaults, user, 'X'));
});

test('changedFiles unions deleted, modified and untracked paths, excluding its own output', () => {
  const calls = [];
  const files = changedFiles(args => { calls.push(args); return args[0] === 'diff' ? 'B.cs\0A.cs\0out.slnf\0' : 'A.cs\0C.cs\0'; }, 'SHA', 'out.slnf');
  assert.deepEqual(files, ['A.cs', 'B.cs', 'C.cs']);
  assert.deepEqual(calls, [['diff', '--name-only', '--no-renames', '-z', 'SHA'], ['ls-files', '--others', '--exclude-standard', '-z']]);
});

test('build inputs are case insensitive and config globs support *, ** and ?', async () => {
  for (const path of ['nested/NuGet.Config', '.editorconfig', '.globalconfig', 'Directory.Build.rsp', 'Directory.Solution.props', 'Directory.Solution.targets', 'x.sln', 'x.slnx', 'x.slnf', 'x.ruleset', 'x.props', 'x.targets', '.config/x', 'eng/x', 'build/x', 'go.sh', 'go.ps1', 'go.cmd', 'Source/a/x.yml']) {
    const result = await decide({ root, projects: [], changed: [path], config: { fullOnPaths: ['Source/?/*.yml'] } }, { install: () => assert.fail('tool must not install') });
    assert.equal(result.reasons[0].rule, 'build-input', path);
  }
  const result = await decide({ root, projects: [], changed: ['Frontend/nested/x.ts'], config: { ignorePaths: ['Frontend/**'] } }, { install: () => 'fake', runTool: () => ({ exit: 166, stdout: '' }) });
  assert.equal(result.mode, 'none');
});

test('selection outside solution is a tool error', async () => {
  const result = await decide({ root, projects: [], changed: ['A.cs'], config: {} }, { install: () => 'fake', runTool: () => ({ exit: 0, stdout: output(['Unknown.csproj']) }) });
  assert.equal(result.reasons[0].rule, 'tool-error');
  assert.match(result.reasons[0].detail, /selection outside solution/);
});

test('help precedes any git or filesystem call', async () => {
  for (const flag of ['--help', '-h']) {
    let printed = '';
    assert.equal(await main([flag], { stdout: text => { printed += text; }, git: () => assert.fail('git called'), env: {} }), 0);
    assert.equal(printed, HELP);
  }
});

function toyRepo(ignored = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-affected-toy-')));
  const put = (name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); };
  put('Toy.slnx', '<Solution><Project Path="A/A.csproj"/><Project Path="B/B.csproj"/></Solution>');
  put('A/A.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
  put('B/B.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="../A/A.csproj"/></ItemGroup></Project>');
  put('A/Class1.cs', 'public class A {}');
  put('B/Class1.cs', 'public class B {}');
  put('.gitignore', `${ignored ? '.ai-work/\n' : ''}**/bin/\n**/obj/\n`);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q'); git('config', 'core.excludesFile', '/dev/null');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial');
  return { dir, put, git };
}

test('CLI real git and fake tool: shape, invocation, output fallback and stale removal', async () => {
  for (const ignored of [true, false]) {
    const { dir, put, git } = toyRepo(ignored);
    put('A/Class1.cs', 'public class A { public int X; }');
    git('rm', '-q', 'B/Class1.cs');
    put('A/Untracked.cs', 'public class Other {}');
    const fakeDir = mkdtempSync(join(tmpdir(), 'pi-affected-fake-'));
    const fake = join(fakeDir, 'tool');
    const received = join(fakeDir, 'received.json');
    writeFileSync(fake, '#!/usr/bin/env node\nimport fs from "node:fs"; fs.writeFileSync(process.env.RECEIVED, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),dotnet:process.env.DOTNET_ROOT})); console.log("DRY-RUN: CONTENTS:\\n"+process.cwd()+"/A/A.csproj"); process.exit(Number(process.env.FAKE_EXIT ?? 0));\n');
    chmodSync(fake, 0o755);
    let text = '';
    let error = '';
    const deps = { env: { ...process.env, PI_AFFECTED_TOOL: fake, PI_AFFECTED_CONFIG: join(fakeDir, 'missing'), RECEIVED: received }, stdout: s => { text += s; }, stderr: s => { error += s; } };
    const args = ['--repo', dir, '--from', 'HEAD', '--json'];
    assert.equal(await main(args, deps), 0, error);
    const report = JSON.parse(text);
    assert.deepEqual(Object.keys(report).sort(), ['schema', 'mode', 'iterationOnly', 'repo', 'root', 'solution', 'base', 'target', 'projects', 'added', 'reasons', 'notes', 'changed', 'tool'].sort());
    assert.equal(report.schema, 1); assert.equal(report.iterationOnly, true); assert.equal(report.mode, 'selected');
    assert.equal(report.changed.count, 3); assert.equal(report.tool.ran, true); assert.equal(report.tool.exit, 0);
    assert.equal(report.target.startsWith(join(dir, '.ai-work', 'affected')), ignored);
    assert.ok(existsSync(report.target));
    const invocation = JSON.parse(readFileSync(received, 'utf8'));
    assert.deepEqual(invocation.args, ['--filter-file-path', 'Toy.slnx', '--from', git('rev-parse', 'HEAD').trim(), '--uncommitted', 'All', '--format', 'text', '--dry-run']);
    assert.equal(invocation.cwd, dir); assert.ok(invocation.dotnet);
    put('global.json', '{}'); text = '';
    assert.equal(await main(args, deps), 0, error);
    assert.equal(JSON.parse(text).mode, 'full'); assert.equal(existsSync(report.target), false);
  }
});

test('CLI resolves origin default merge-base and rejects invalid environment or options', async () => {
  const { dir, git } = toyRepo();
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  let text = ''; let error = '';
  const deps = { env: { ...process.env, PI_AFFECTED_CONFIG: join(dir, 'missing') }, stdout: s => { text = s; }, stderr: s => { error = s; } };
  assert.equal(await main(['--repo', dir, '--json'], deps), 0, error);
  assert.equal(JSON.parse(text).base.ref, 'origin/main');
  assert.equal(JSON.parse(text).mode, 'none');
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.equal(await main(['--repo', dir], deps), 1); assert.match(error, /pass --from/);
  for (const args of [['--wat'], ['--timeout', '0'], ['--repo']]) assert.equal(await main(args, deps), 1);
});

function fakeTool(selected) {
  const fakeDir = mkdtempSync(join(tmpdir(), 'pi-affected-fake-'));
  const fake = join(fakeDir, 'tool');
  writeFileSync(fake, `#!/usr/bin/env node\nconsole.log("DRY-RUN: CONTENTS:\\n"+process.cwd()+"/${selected}");\n`);
  chmodSync(fake, 0o755);
  return { env: { ...process.env, PI_AFFECTED_TOOL: fake, PI_AFFECTED_CONFIG: join(fakeDir, 'missing') }, fakeDir };
}
async function runCli(args, env) {
  let text = ''; let error = '';
  const code = await main(args, { env, stdout: s => { text += s; }, stderr: s => { error += s; } });
  return { code, text, error };
}

test('solution in a subdirectory: entries resolve relative to the solution, including sln backslashes', async () => {
  for (const [file, body] of [
    ['sub/Toy.slnx', '<Solution><Project Path="P/P.csproj"/><Project Path="Q/Q.csproj"/></Solution>'],
    ['sub/Toy.sln', 'Project("{X}") = "P", "P\\P.csproj", "{Y}"\nProject("{X}") = "Q", "Q\\Q.csproj", "{Z}"'],
  ]) {
    const { dir, put, git } = toyRepo();
    put(file, body);
    put('sub/P/P.csproj', '<Project/>'); put('sub/Q/Q.csproj', '<Project/>'); put('sub/P/C.cs', 'class C {}');
    git('add', '.'); git('-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'sub');
    put('sub/P/C.cs', 'class C { int x; }');
    const { env } = fakeTool('sub/P/P.csproj');
    const { code, text, error } = await runCli(['--repo', dir, '--solution', file, '--from', 'HEAD', '--json'], env);
    assert.equal(code, 0, error);
    const report = JSON.parse(text);
    assert.equal(report.mode, 'selected', file);
    assert.deepEqual(report.projects, ['sub/P/P.csproj']);
    const slnf = JSON.parse(readFileSync(report.target, 'utf8'));
    assert.equal(slnf.solution.projects.length, 1, file);
    assert.match(slnf.solution.projects[0], /^P[\\/]P\.csproj$/);
    assert.equal(resolve(dirname(report.target), slnf.solution.path), join(dir, file));
  }
});

test('--out never destroys a file it did not generate, and refuses directories', async () => {
  const { dir, put } = toyRepo();
  put('A/Class1.cs', 'public class A { public int X; }');
  const { env, fakeDir } = fakeTool('A/A.csproj');
  const precious = join(fakeDir, 'precious.txt');
  writeFileSync(precious, 'keep me');
  let result = await runCli(['--repo', dir, '--from', 'HEAD', '--out', precious], env);
  assert.equal(result.code, 1); assert.match(result.error, /refusing to overwrite/);
  assert.equal(readFileSync(precious, 'utf8'), 'keep me');
  result = await runCli(['--repo', dir, '--from', 'HEAD', '--out', fakeDir], env);
  assert.equal(result.code, 1); assert.ok(existsSync(fakeDir));
  assert.deepEqual(readdirSync(fakeDir).filter(name => name.includes('.tmp-')), []);
  put('global.json', '{}');
  for (const target of [precious, fakeDir]) {
    result = await runCli(['--repo', dir, '--from', 'HEAD', '--out', target], env);
    assert.equal(result.code, 0, result.error);
  }
  assert.equal(readFileSync(precious, 'utf8'), 'keep me'); assert.ok(existsSync(fakeDir));
  const generated = join(fakeDir, 'ok.slnf');
  put('global.json', '{}'); // full mode removes only generated filters
  writeFileSync(generated, JSON.stringify({ solution: { path: 'x', projects: [] } }));
  assert.equal((await runCli(['--repo', dir, '--from', 'HEAD', '--out', generated], env)).code, 0);
  assert.equal(existsSync(generated), false);
});

test('failed tool install removes its temporary directory and leaves no tool directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-affected-install-'));
  const bin = join(root, 'bin'); const cache = join(root, 'cache');
  mkdirSync(bin);
  writeFileSync(join(bin, 'dotnet'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --tool-path ] && mkdir -p "$2/partial"; shift; done\nexit 1\n');
  chmodSync(join(bin, 'dotnet'), 0o755);
  assert.throws(() => install({ ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_AFFECTED_CACHE: cache, DOTNET_ROOT: '/nonexistent' }));
  assert.deepEqual(readdirSync(cache), []);
});

test('live: pinned tool relocates, selects dependents and builds slnf over slnx', { skip: !process.env.PI_AFFECTED_LIVE }, async () => {
  const { dir, put } = toyRepo();
  put('A/Class1.cs', 'public class A { public int X; }');
  const cache = mkdtempSync(join(tmpdir(), 'pi-affected-live-cache-'));
  let text = ''; let error = '';
  const env = { ...process.env, PI_AFFECTED_CACHE: cache, PI_AFFECTED_CONFIG: join(cache, 'missing') };
  delete env.PI_AFFECTED_TOOL;
  const deps = { env, stdout: s => { text = s; }, stderr: s => { error = s; } };
  assert.equal(await main(['--repo', dir, '--from', 'HEAD', '--json'], deps), 0, error);
  const report = JSON.parse(text);
  assert.equal(report.mode, 'selected', JSON.stringify(report));
  assert.deepEqual(report.projects, ['A/A.csproj', 'B/B.csproj']);
  const exe = join(cache, 'dotnet-affected-7.0.1', 'dotnet-affected');
  assert.match(execFileSync(exe, ['--version'], { encoding: 'utf8', env: { ...env, DOTNET_ROOT: env.DOTNET_ROOT || '/usr/local/share/dotnet' } }), /7\.0\.1/);
  assert.equal(report.tool.version, '7.0.1');
  execFileSync('dotnet', ['build', report.target, '-p:NuGetAudit=false'], { cwd: dir, env, stdio: 'inherit', timeout: 300000 });
});
