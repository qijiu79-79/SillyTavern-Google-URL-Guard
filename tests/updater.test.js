import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionUpdater, installationTarget, isReleaseRemote, reloadBlockReason, REPOSITORY } from '../updater.js';

const folder = 'SillyTavern-Google-URL-Guard';
const moduleUrl = `http://localhost:8000/scripts/extensions/third-party/${folder}/index.js`;
const oldHash = 'a'.repeat(40);
const newHash = 'b'.repeat(40);
const version = (overrides = {}) => ({ currentBranchName: 'main', currentCommitHash: oldHash,
    isUpToDate: false, remoteUrl: REPOSITORY, ...overrides });

function fixture(options = {}) {
    const calls = [];
    let downloaded = false;
    const updater = new ExtensionUpdater({ moduleUrl, request: async (path, body) => {
        calls.push({ path, body });
        if (path.endsWith('/discover')) return [{ name: `third-party/${folder}`, type: options.global ? 'global' : 'local' }];
        if (path.endsWith('/version')) return options.version?.(downloaded) ?? version(downloaded
            ? { currentCommitHash: newHash, isUpToDate: true } : {});
        if (path.endsWith('/update')) {
            if (options.fail) throw new Error('test failure');
            downloaded = true;
            return options.result ?? { shortCommitHash: newHash.slice(0, 7), isUpToDate: false, remoteUrl: REPOSITORY };
        }
        throw new Error('unexpected path');
    } });
    return { updater, calls };
}

test('target resolver supports local/global installs and renamed folders', () => {
    for (const type of ['local', 'global']) {
        assert.deepEqual(installationTarget(moduleUrl, [{ name: `third-party/${folder}`, type }]),
            { extensionName: folder, global: type === 'global' });
    }
    assert.deepEqual(installationTarget(moduleUrl.replace(folder, 'renamed-folder'), [{ name: 'third-party/renamed-folder', type: 'local' }]),
        { extensionName: 'renamed-folder', global: false });
    for (const list of [[], {}, [{ name: `third-party/${folder}`, type: 'system' }],
        [{ name: `third-party/${folder}`, type: 'local' }, { name: `third-party/${folder}`, type: 'global' }]]) {
        assert.throws(() => installationTarget(moduleUrl, list));
    }
    assert.throws(() => installationTarget('http://localhost/index.js', []));
});

test('only the release remote is allowed', () => {
    for (const remote of [REPOSITORY, REPOSITORY + '.git', REPOSITORY + '/',
        REPOSITORY.replace('https://github.com/', 'git@github.com:') + '.git']) assert.equal(isReleaseRemote(remote), true);
    for (const remote of [null, '', REPOSITORY + '-evil', REPOSITORY.replace('github.com', 'github.com.evil.test'),
        REPOSITORY + '?x=1', REPOSITORY.replace('https://', 'http://')]) assert.equal(isReleaseRemote(remote), false);
});

test('check does not download; update downloads once and verifies resulting commit', async () => {
    const { updater, calls } = fixture();
    await updater.run(false);
    assert.equal(updater.state.phase, 'available');
    assert.equal(calls.some(call => call.path.endsWith('/update')), false);
    await updater.run(true);
    assert.equal(updater.state.phase, 'updated');
    assert.equal(calls.filter(call => call.path.endsWith('/update')).length, 1);
    assert.deepEqual(calls.at(-1).body, { extensionName: folder, global: false });
    await updater.run(true);
    assert.equal(calls.filter(call => call.path.endsWith('/update')).length, 1);
});

test('global install uses the correct update target', async () => {
    const { updater, calls } = fixture({ global: true });
    await updater.run(true);
    assert.equal(calls.find(call => call.path.endsWith('/update')).body.global, true);
});

test('up-to-date branch does not download or request refresh', async () => {
    const { updater, calls } = fixture({ version: () => version({ isUpToDate: true }) });
    await updater.run(true);
    assert.equal(updater.state.phase, 'current');
    assert.equal(calls.some(call => call.path.endsWith('/update')), false);
});

test('untrusted source, ZIP install, or malformed response cannot trigger update', async () => {
    for (const info of [version({ remoteUrl: 'https://github.com/other/repo' }),
        { currentCommitHash: '', remoteUrl: '' }, version({ currentCommitHash: '?' }), version({ isUpToDate: undefined })]) {
        const { updater, calls } = fixture({ version: () => info });
        await updater.run(true);
        assert.equal(updater.state.phase, 'error');
        assert.equal(calls.some(call => call.path.endsWith('/update')), false);
    }
});

test('failed/uncertain update does not refresh or automatically repeat writes', async () => {
    const { updater, calls } = fixture({ fail: true });
    await updater.run(true);
    assert.equal(updater.state.phase, 'error');
    await updater.run(true);
    assert.equal(updater.state.phase, 'error');
    assert.equal(calls.filter(call => call.path.endsWith('/update')).length, 1);
});

test('mismatched post-update version never triggers automatic refresh', async () => {
    for (const info of [version({ currentCommitHash: newHash, isUpToDate: false }),
        version({ currentCommitHash: newHash, currentBranchName: 'other', isUpToDate: true }),
        version({ currentCommitHash: 'c'.repeat(40), isUpToDate: true })]) {
        const { updater } = fixture({ version: downloaded => downloaded ? info : version() });
        await updater.run(true);
        assert.equal(updater.state.phase, 'error');
    }
});

test('concurrent clicks share one operation', async () => {
    const { updater, calls } = fixture();
    const one = updater.run(true);
    const two = updater.run(true);
    assert.equal(one, two);
    await Promise.all([one, two]);
    assert.equal(calls.filter(call => call.path.endsWith('/update')).length, 1);
});

test('all safety conditions block reload, idle state allows it', () => {
    assert.equal(reloadBlockReason({}), '');
    for (const key of ['generating', 'pendingRequests', 'draft', 'editing', 'dialog', 'dirty', 'hidden', 'recentActivity']) {
        assert.notEqual(reloadBlockReason({ [key]: true }), '', key);
    }
});
