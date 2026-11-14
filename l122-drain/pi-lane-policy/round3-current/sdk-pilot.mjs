import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = '/Users/sindrewilting/.local/share/pi-runtime/lib/node_modules/@earendil-works/pi-coding-agent';
const sourceFiles = ['extensions/lane-policy.ts', 'extensions/guards.ts', 'extensions/wait-guard.ts', 'lib/lane-policy.ts', 'lib/guards.ts'];
const hash = p => existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null;
const json = p => JSON.parse(readFileSync(p, 'utf8'));

if (process.argv[2] !== '--child') {
    const liveAgent = join(homedir(), '.pi/agent');
    const protectedPaths = [join(liveAgent, 'guards.json'), join(liveAgent, 'lane-policy/policy.json'), ...sourceFiles.map(p => join(liveAgent, p))];
    const before = protectedPaths.map(hash);
    const root = mkdtempSync(join(here, 'pilot-fixture-'));
    const home = join(root, 'home');
    const agentDir = join(home, '.pi/agent');
    for (const path of [home, agentDir, join(root, 'tmp'), join(home, '.config'), join(home, '.cache')]) mkdirSync(path, { recursive: true, mode: 0o700 });
    for (const relative of sourceFiles) {
        const from = join(liveAgent, relative), to = join(agentDir, relative);
        assert.equal(lstatSync(from).isSymbolicLink(), false, `source must not be a symlink: ${relative}`);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        assert.equal(lstatSync(to).isSymbolicLink(), false);
        assert.equal(hash(from), hash(to), `not an exact source copy: ${relative}`);
    }
    // A fresh child environment, not a spread of the operator's credentials/configuration.
    const env = {
        HOME: home, PATH: `${join(agentDir, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
        PI_CODING_AGENT_DIR: agentDir, PI_GUARDS_FILE: join(agentDir, 'guards.json'), PI_OFFLINE: '1',
        XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: join(root, 'tmp'),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'absent-gitconfig'),
        LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TERM: 'dumb', NO_COLOR: '1',
        PILOT_LIVE_AGENT: liveAgent,
    };
    console.log(`PILOT fixture=${root}; sources=byte-copied; child-env=whitelist; no live session reload`);
    try {
        const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', root], { cwd: root, env, stdio: 'inherit', timeout: 110000 });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, `isolated SDK child failed (signal=${result.signal})`);
    } finally {
        assert.deepEqual(protectedPaths.map(hash), before, 'live source/guard/policy bytes changed during pilot');
        console.log('LIVE_BYTES_UNCHANGED: source copies, guards.json and lane-policy/policy.json');
    }
} else {
    const root = realpathSync(process.argv[3]);
    const home = join(root, 'home'), agentDir = join(home, '.pi/agent'), policyPath = join(agentDir, 'lane-policy/policy.json');
    assert.equal(process.env.HOME, home); assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
    assert.notEqual(realpathSync(agentDir), realpathSync(process.env.PILOT_LIVE_AGENT));
    assert.equal(process.env.PI_GUARDS_OFF, undefined);
    assert.equal(existsSync(policyPath), false);
    const noSymlinks = path => { assert.equal(lstatSync(path).isSymbolicLink(), false, path); if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) noSymlinks(join(path, name)); };
    noSymlinks(home);
    console.log(`ISOLATION_OK HOME=${home}; agentDir=${agentDir}; policy=${policyPath}; no symlink or live path`);

    // Reject any accidental network attempt, before importing the actual SDK/provider code.
    let networkAttempts = 0;
    const noNetwork = () => { networkAttempts++; throw new Error('Network is forbidden in this offline SDK pilot'); };
    globalThis.fetch = noNetwork;
    for (const [module, methods] of [['node:http', ['request', 'get']], ['node:https', ['request', 'get']], ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']]]) {
        const api = (await import(module)).default;
        for (const method of methods) api[method] = noNetwork;
    }
    const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports();
    const repo = join(root, 'repo'), outside = join(root, 'outside');
    mkdirSync(repo); mkdirSync(outside);
    const nativeGit = '/usr/bin/git';
    const setup = (...args) => execFileSync(nativeGit, ['-C', repo, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    setup('init', '-b', 'pilot-lane');
    setup('-c', 'user.name=SDK Pilot', '-c', 'user.email=pilot@example.invalid', 'commit', '--allow-empty', '-m', 'isolated pilot');
    setup('remote', 'add', 'origin', 'git@github.com:Pilot/Fixture.git');

    const invocationLog = join(root, 'executable-invocations.jsonl');
    const bin = join(agentDir, 'bin'); mkdirSync(bin);
    const stub = `#!${process.execPath}\n` + `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2), program = path.basename(process.argv[1]);
const log = kind => fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({kind, args, cwd: process.cwd(), home: process.env.HOME, session: process.env.PI_SESSION_ID ?? null}) + '\\n');
if (program === 'gh') { log('gh'); console.log('PILOT_GH_STUB_ONLY'); process.exit(0); }
let rest = [...args];
while (rest[0]?.startsWith('-')) {
    const flag = rest.shift();
    if (flag === '-C') rest.shift();
    else if (!flag.startsWith('-C') && !['--no-pager', '--paginate', '-p', '-P', '--no-optional-locks'].includes(flag)) { log('unexpected-git'); process.exit(91); }
}
if (rest[0] === 'push') { log('git-push'); console.log('PILOT_GIT_PUSH_STUB_ONLY'); process.exit(0); }
if (['rev-parse', 'symbolic-ref'].includes(rest[0]) || (rest[0] === 'remote' && rest[1] === 'get-url')) {
    log('git-read');
    const result = cp.spawnSync(${JSON.stringify(nativeGit)}, args, {encoding:'utf8', timeout:3000});
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); process.exit(result.status ?? 92);
}
log('unexpected-git'); console.error('Pilot native Git allowlist rejected invocation'); process.exit(93);
`;
    for (const name of ['git', 'gh']) { const path = join(bin, name); writeFileSync(path, stub); chmodSync(path, 0o700); }
    const shellResolution = execFileSync('/bin/bash', ['-c', 'command -v git; command -v gh'], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(shellResolution, [join(bin, 'git'), join(bin, 'gh')]);
    console.log('EXECUTABLE_ISOLATION_OK actual Bash PATH resolves fixture Git/GH stubs; native Git delegated only for read identity/config');

    const sdk = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
    const ai = await import(pathToFileURL(join(sdkRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createBashToolDefinition } = sdk;
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = ai;
    console.log(`ACTUAL_SDK version=${json(join(sdkRoot, 'package.json')).version}; native fauxProvider; no model/network inference`);
    const faux = fauxProvider({ provider: 'lane-policy-offline-pilot', models: [{ id: 'scripted', contextWindow: 128000, maxTokens: 1024 }] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store.json'), refreshModelsOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const settings = () => SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false }, retry: { enabled: false }, shellPath: '/bin/bash' });
    const sessions = [];
    const errors = [], contexts = [], spawns = [], cases = [], jobExecutions = [];
    const invocations = () => existsSync(invocationLog) ? readFileSync(invocationLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const publicationCount = kind => invocations().filter(x => x.kind === kind).length;
    const create = async (label, cwd) => {
        const settingsManager = settings();
        const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [join(agentDir, 'extensions/guards.ts'), join(agentDir, 'extensions/lane-policy.ts')], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
        await resourceLoader.reload();
        assert.deepEqual(resourceLoader.getExtensions().errors, []);
        const paths = resourceLoader.getExtensions().extensions.map(e => e.path);
        assert.equal(paths.length, 2); assert.ok(paths.every(p => p.startsWith(agentDir + '/')));
        const manager = SessionManager.inMemory(cwd);
        const events = [], notices = [], confirmations = [], statuses = [];
        const bashDefinition = createBashToolDefinition(cwd, { shellPath: '/bin/bash', spawnHook: context => {
            assert.equal(context.env.HOME, home); assert.equal(context.env.PATH.split(':')[0], bin);
            spawns.push({ label, command: context.command, cwd: context.cwd, session: context.env.PI_SESSION_ID });
            return context; // observation only: real built-in local Bash operations are unchanged
        } });
        // Simulated job worker, real SDK dispatch and nested tool execution. This does not claim
        // to validate the installed job scheduler/package or its background process lifecycle.
        const jobDefinition = { name: 'job_start', label: 'Pilot simulated job worker', description: 'Offline pilot job wrapper', parameters: bashDefinition.parameters,
            execute: async (_id, args, _signal, _update, ctx) => {
                jobExecutions.push({ label, command: args.command });
                const outcome = await ctx.executeTool('bash', args);
                if (outcome.isError) throw new Error(outcome.result.content.filter(x => x.type === 'text').map(x => x.text).join('\n'));
                return outcome.result;
            } };
        const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager, settingsManager, resourceLoader, modelRuntime: runtime, model: faux.getModel(), tools: ['bash', 'job_start'], customTools: [bashDefinition, jobDefinition], thinkingLevel: 'off' });
        session.subscribe(event => { if (event.type.startsWith('tool_execution')) events.push({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError }); });
        await session.bindExtensions({ mode: 'tui', uiContext: {
            confirm: async (title, message) => { confirmations.push({ title, message }); console.log(`SIMULATED_OPERATOR_CONFIRM session=${label} title=${title}`); return true; },
            notify: (message, type) => notices.push({ message, type }),
            setStatus: (key, text) => statuses.push({ key, text }),
        }, onError: error => errors.push(error) });
        const item = { label, session, manager, events, notices, confirmations, statuses }; sessions.push(item);
        console.log(`REAL_SESSION label=${label}; id=${session.sessionId}; cwd=${cwd}; copied extensions loaded via SDK resource loader`);
        return item;
    };
    let sequence = 0;
    const operator = async (item, command) => {
        assert.equal(faux.getPendingResponseCount(), 0);
        const modelCalls = faux.state.callCount;
        await item.session.prompt(command);
        assert.equal(faux.state.callCount, modelCalls, 'operator slash command unexpectedly reached model');
        assert.deepEqual(errors, []);
        assert.equal(item.notices.filter(x => x.type === 'error').length, 0, JSON.stringify(item.notices));
        console.log(`REAL_COMMAND session=${item.label} ${command}`);
    };
    const toolCase = async (item, label, command, allowed, expectedOutput, publicationKind, toolName = 'bash') => {
        const id = `pilot-${++sequence}`, beforeSpawn = spawns.length, beforeJobs = jobExecutions.length;
        const beforeGit = publicationCount('git-push'), beforeGh = publicationCount('gh');
        const beforeModel = faux.state.callCount;
        faux.setResponses([
            context => { contexts.push({ label, transcript: JSON.stringify(context) }); return fauxAssistantMessage([fauxToolCall(toolName, { command, timeout: 5 }, { id })], { stopReason: 'toolUse' }); },
            fauxAssistantMessage('Scripted pilot turn complete.'),
        ]);
        await item.session.prompt(`Offline scripted runtime case: ${label}`);
        assert.equal(faux.state.callCount, beforeModel + 2); assert.equal(faux.getPendingResponseCount(), 0);
        assert.deepEqual(errors, []);
        const result = item.session.messages.find(x => x.role === 'toolResult' && x.toolCallId === id);
        assert.ok(result, `real agent loop produced no toolResult: ${label}`);
        const text = result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
        assert.equal(!!result.isError, !allowed, `${label}: ${text}`);
        assert.match(text, expectedOutput);
        assert.equal(spawns.length - beforeSpawn, allowed ? 1 : 0, `${label}: blocked call must not reach built-in Bash spawn hook`);
        const gitDelta = publicationCount('git-push') - beforeGit, ghDelta = publicationCount('gh') - beforeGh;
        assert.equal(gitDelta, allowed && publicationKind === 'git-push' ? 1 : 0);
        assert.equal(ghDelta, allowed && publicationKind === 'gh' ? 1 : 0);
        const toolEvents = item.events.filter(x => x.toolCallId === id);
        assert.ok(toolEvents.some(x => x.type === 'tool_execution_end'), `missing real SDK execution-end event: ${label}`);
        assert.equal(jobExecutions.length - beforeJobs, allowed && toolName === 'job_start' ? 1 : 0, `${label}: job guard must run before job execute()`);
        cases.push({ label, toolName, allowed, gitStubDelta: gitDelta, ghStubDelta: ghDelta, jobExecutionDelta: jobExecutions.length - beforeJobs, bashSpawnDelta: spawns.length - beforeSpawn, text: text.slice(0, 220) });
        console.log(`RUNTIME_CASE ${JSON.stringify(cases.at(-1))}`);
    };
    try {
        const writer = await create('writer', repo), nonwriter = await create('nonwriter', repo);
        assert.notEqual(writer.session.sessionId, nonwriter.session.sessionId);
        await toolCase(writer, 'no-policy-ordinary-command', 'printf pilot-ordinary', true, /pilot-ordinary/);
        assert.equal(existsSync(policyPath), false);
        await operator(writer, '/lane-policy bootstrap Pilot/Fixture');
        await operator(writer, `/lane-policy enroll ${writer.session.sessionId} pilot-writer pilot-lane push,pr-create`);
        await operator(writer, `/lane-policy enroll ${nonwriter.session.sessionId} pilot-nonwriter pilot-lane push,pr-create`);
        await operator(writer, `/lane-policy writer ${writer.session.sessionId} pilot-lane push,pr-create`);
        await operator(writer, `/lane-policy grant ${writer.session.sessionId} push pilot-lane 5 minutes`);
        assert.equal(json(policyPath).revision, 5);
        await operator(writer, '/lane-policy ack 5');
        await operator(nonwriter, '/lane-policy ack 5');
        assert.equal(json(policyPath).revision, 5); assert.equal(json(policyPath).acknowledgements.length, 2);
        await toolCase(writer, 'current-revision-writer-push', 'git push origin pilot-lane:pilot-lane', true, /PILOT_GIT_PUSH_STUB_ONLY/, 'git-push');
        assert.match(contexts.at(-1).transcript, /Lane policy r5/); assert.match(contexts.at(-1).transcript, /ACK=current/);
        await toolCase(nonwriter, 'acked-nonwriter-push-denied', 'git push origin pilot-lane:pilot-lane', false, /not the writer/);
        await toolCase(nonwriter, 'acked-nonwriter-pr-denied', 'gh pr create -R Pilot/Fixture --head pilot-lane --title pilot', false, /not the writer/);
        const child = await create('unbound-child-surrogate', repo);
        const buildFile = join(root, 'ordinary-build.mjs'), scriptFile = join(root, 'ordinary-script.sh');
        writeFileSync(buildFile, `console.log('PILOT_BUILD_OK');`);
        writeFileSync(scriptFile, `printf 'PILOT_SCRIPT_OK\\n'`);
        const buildCommand = `'${process.execPath}' '${buildFile}'`;
        await toolCase(child, 'unbound-child-build-allowed', buildCommand, true, /PILOT_BUILD_OK/);
        await toolCase(child, 'unbound-child-script-allowed', `bash '${scriptFile}'`, true, /PILOT_SCRIPT_OK/);
        await toolCase(child, 'unbound-child-push-denied', 'git push origin pilot-lane:pilot-lane', false, /not bound/);
        await toolCase(child, 'unbound-child-pr-denied', 'gh pr create -R Pilot/Fixture --head pilot-lane --title child', false, /not bound/);
        await toolCase(child, 'unbound-child-shell-publication-denied', "sh -c 'git push origin pilot-lane:pilot-lane'", false, /not bound/);
        await toolCase(child, 'unbound-child-job-ordinary-allowed', buildCommand, true, /PILOT_BUILD_OK/, undefined, 'job_start');
        await toolCase(child, 'unbound-child-job-push-denied', 'git push origin pilot-lane:pilot-lane', false, /not bound/, undefined, 'job_start');
        await operator(writer, '/lane-policy forbid Pilot/Fixture/#41');
        assert.equal(json(policyPath).revision, 6);
        await toolCase(writer, 'revision-bump-invalidates-push', 'git push origin pilot-lane:pilot-lane', false, /current-revision unexpired/);
        assert.match(contexts.at(-1).transcript, /Lane policy r6/); assert.match(contexts.at(-1).transcript, /ACK=stale r5/);
        await operator(writer, '/lane-policy ack 6'); assert.equal(json(policyPath).revision, 6);
        await toolCase(writer, 'fresh-ack-does-not-revive-grant', 'git push origin pilot-lane:pilot-lane', false, /current-revision unexpired/);
        assert.match(contexts.at(-1).transcript, /ACK=current/);
        await operator(writer, `/lane-policy grant ${writer.session.sessionId} pr-create pilot-lane 5 minutes`);
        assert.equal(json(policyPath).revision, 7);
        await toolCase(writer, 'current-revision-writer-pr', 'gh pr create -R Pilot/Fixture --head pilot-lane --title pilot', true, /PILOT_GH_STUB_ONLY/, 'gh');
        await operator(writer, '/guards off lane-policy');
        await toolCase(nonwriter, 'operator-off-isolated-bypass', 'git push origin main:main', true, /PILOT_GIT_PUSH_STUB_ONLY/, 'git-push');
        await operator(writer, '/guards on lane-policy');
        await toolCase(nonwriter, 'operator-on-restores-denial', 'git push origin main:main', false, /not bound|integration/);
        const unknown = await create('outside-unbound', outside);
        await toolCase(unknown, 'unenrolled-ordinary-command', 'printf outside-ordinary', true, /outside-ordinary/);
        await toolCase(unknown, 'outside-attached-target-no-inheritance', `git -C'${repo}' push origin pilot-lane:pilot-lane`, false, /not bound/);
        assert.deepEqual(errors, []);
        assert.equal(networkAttempts, 0);
        assert.equal(invocations().filter(x => x.kind === 'unexpected-git').length, 0);
        assert.ok(invocations().every(x => x.home === home));
        assert.equal(json(policyPath).revision, 7);
        assert.equal(publicationCount('git-push'), 2); assert.equal(publicationCount('gh'), 1);
        writeFileSync(join(root, 'runtime-cases.json'), JSON.stringify({ sdk: json(join(sdkRoot, 'package.json')).version, cases, spawns, jobExecutions, networkAttempts, simulatedConfirmations: sessions.reduce((n, x) => n + x.confirmations.length, 0), sessions: sessions.map(x => ({ label: x.label, id: x.session.sessionId, executionEvents: x.events, statuses: x.statuses.slice(-4) })) }, null, 2));
        console.log(`PILOT_PASS cases=${cases.length}; real-SDK-sessions=${sessions.length}; git-push-stub=2; gh-stub=1; network-attempts=0; policy-r7; artifacts=${root}`);
    } finally {
        for (const item of sessions) item.session.dispose();
    }
}
