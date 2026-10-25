import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedFetch, isChatEndpoint, normalizeGooglePayload, stripTrailingV1 } from '../guard.js';

const baseUrl = 'http://localhost:8000/';
const endpoint = '/api/backends/chat-completions/generate';
const google = { chat_completion_source: 'makersuite', reverse_proxy: 'https://example.com/gemini/v1',
    proxy_password: 'dummy-secret', messages: [{ role: 'user', content: 'test' }], stream: true };

for (const [input, output] of [
    ['https://example.com/v1', 'https://example.com'],
    ['https://example.com/v1/', 'https://example.com'],
    ['https://example.com/v1///', 'https://example.com'],
    ['https://example.com/v1/v1/', 'https://example.com'],
    ['https://example.com/gemini/v1?x=%2Fv1&x=2#hello', 'https://example.com/gemini?x=%2Fv1&x=2#hello'],
    ['http://localhost:9999/prefix/v1', 'http://localhost:9999/prefix'],
    ['  https://example.com/v1  ', 'https://example.com'],
    ['https://example.com/v1beta', 'https://example.com/v1beta'],
    ['https://example.com/v1/models', 'https://example.com/v1/models'],
    ['https://example.com/v10', 'https://example.com/v10'],
    ['https://v1', 'https://v1'],
    ['https://v1/', 'https://v1/'],
    ['https://v1/v1', 'https://v1'],
    ['https://example.com/?next=/v1', 'https://example.com/?next=/v1'],
    ['https://example.com/#/v1', 'https://example.com/#/v1'],
    ['https://example.com/api/', 'https://example.com/api/'],
    ['  https://example.com/api/  ', '  https://example.com/api/  '],
    ['ftp://example.com/v1', 'ftp://example.com/v1'],
    ['not-a-url/v1', 'not-a-url/v1'], ['', ''], [null, null], [undefined, undefined],
]) test(`URL: ${String(input)}`, () => {
    assert.equal(stripTrailingV1(input), output);
    assert.equal(stripTrailingV1(output), output, 'idempotent');
});

test('only the per-request Google source changes; all other settings remain identical', () => {
    const original = structuredClone(google);
    const fixed = normalizeGooglePayload(google);
    assert.equal(fixed.reverse_proxy, 'https://example.com/gemini');
    assert.deepEqual(google, original);
    assert.equal(fixed.messages, google.messages);
    assert.deepEqual({ ...fixed, reverse_proxy: google.reverse_proxy }, google);
    for (const source of ['openai', 'custom', 'claude', 'vertexai', 'openrouter', undefined]) {
        const payload = { ...google, chat_completion_source: source, model: 'gemini-test' };
        assert.equal(normalizeGooglePayload(payload), payload);
    }
    for (const payload of [null, [], 'string', {}, { chat_completion_source: 'makersuite' }]) {
        assert.equal(normalizeGooglePayload(payload), payload);
    }
});

test('scope is limited to same-origin POST status/generate', () => {
    for (const suffix of ['status', 'generate', 'generate/']) {
        assert.equal(isChatEndpoint(`/api/backends/chat-completions/${suffix}`, { method: 'POST' }, baseUrl), true);
    }
    for (const url of ['https://evil.example/api/backends/chat-completions/generate', '/api/settings/save',
        '/api/backends/chat-completions/generate-extra', '/api/extensions/update', '/api/backends/text-completions/generate']) {
        assert.equal(isChatEndpoint(url, { method: 'POST' }, baseUrl), false);
    }
    assert.equal(isChatEndpoint(endpoint, { method: 'GET' }, baseUrl), false);
    assert.equal(isChatEndpoint(endpoint, {}, baseUrl), false);
});

test('string body preserves headers, cancellation, credentials, response identity and never persists settings', async () => {
    const calls = [];
    const response = new Response('data: stream\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    let repairs = 0;
    const wrapped = createGuardedFetch(async (...args) => { calls.push(args); return response; },
        { enabled: () => true, baseUrl, onRepair: () => repairs++ });
    const controller = new AbortController();
    const init = { method: 'POST', body: JSON.stringify(google), headers: { 'X-CSRF-Token': 'test' },
        signal: controller.signal, credentials: 'same-origin', cache: 'no-cache' };
    assert.equal(await wrapped(endpoint, init), response);
    assert.equal(calls.length, 1);
    assert.equal(repairs, 1);
    assert.equal(calls[0][1].headers, init.headers);
    assert.equal(calls[0][1].signal, init.signal);
    assert.equal(calls[0][1].credentials, init.credentials);
    assert.equal(calls[0][1].cache, init.cache);
    assert.deepEqual(JSON.parse(calls[0][1].body), normalizeGooglePayload(google));
    assert.equal(JSON.parse(init.body).reverse_proxy, google.reverse_proxy);
    assert.equal(await response.text(), 'data: stream\n\n');
});

test('Request objects remain cancellable and keep content/headers; original body not consumed', async () => {
    let captured;
    const controller = new AbortController();
    const request = new Request(baseUrl.slice(0, -1) + endpoint, {
        method: 'POST', body: JSON.stringify(google), signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'dummy' }, credentials: 'include',
    });
    const wrapped = createGuardedFetch(async input => { captured = input; return new Response('ok'); }, { enabled: () => true, baseUrl });
    await wrapped(request);
    assert.equal(request.bodyUsed, false);
    assert.equal(captured.headers.get('X-CSRF-Token'), 'dummy');
    assert.equal(captured.credentials, 'include');
    assert.equal((await captured.json()).reverse_proxy, 'https://example.com/gemini');
    controller.abort();
    assert.equal(captured.signal.aborted, true);
});

test('Request body override is honored; explicit non-string body is not read', async () => {
    let captured;
    const original = new Request(new URL(endpoint, baseUrl), { method: 'POST', body: JSON.stringify(google),
        headers: { 'Content-Type': 'application/json' } });
    const wrapped = createGuardedFetch(async (...args) => { captured = args; }, { enabled: () => true, baseUrl });
    const openaiInit = { body: JSON.stringify({ ...google, chat_completion_source: 'openai' }) };
    await wrapped(original, openaiInit);
    assert.equal(captured[0], original);
    assert.equal(captured[1], openaiInit);
    const blobInit = { body: new Blob([JSON.stringify(google)]) };
    await wrapped(original, blobInit);
    assert.equal(captured[1], blobInit);
});

test('disabled, unrelated, invalid, already-correct and OAI requests are byte-for-byte pass-through', async () => {
    let active = true;
    let captured;
    const wrapped = createGuardedFetch(async (...args) => { captured = args; }, { enabled: () => active, baseUrl });
    for (const [url, body] of [
        [endpoint, '{broken'], [endpoint, 'null'], [endpoint, '[]'],
        [endpoint, JSON.stringify({ ...google, chat_completion_source: 'openai' }, null, 2)],
        [endpoint, JSON.stringify({ ...google, reverse_proxy: 'https://example.com' })],
        ['/api/settings/save', JSON.stringify(google)],
        ['https://example.com' + endpoint, JSON.stringify(google)],
    ]) {
        const init = { method: 'POST', body };
        await wrapped(url, init);
        assert.equal(captured[0], url);
        assert.equal(captured[1], init);
    }
    active = false;
    const init = { method: 'POST', body: JSON.stringify(google) };
    await wrapped(endpoint, init);
    assert.equal(captured[1], init);
});

test('network rejection is propagated once, with no automatic retry', async () => {
    let calls = 0;
    const failure = new Error('test network failure');
    const wrapped = createGuardedFetch(async () => { calls++; throw failure; }, { enabled: () => true, baseUrl });
    await assert.rejects(wrapped(endpoint, { method: 'POST', body: JSON.stringify(google) }), error => error === failure);
    assert.equal(calls, 1);
});

test('reporting failures do not break correction or duplicate a request', async () => {
    let calls = 0;
    const wrapped = createGuardedFetch(async (_, init) => { calls++; assert.equal(JSON.parse(init.body).reverse_proxy, 'https://example.com/gemini'); },
        { enabled: () => true, baseUrl, onRepair: () => { throw new Error('UI failure'); } });
    await wrapped(endpoint, { method: 'POST', body: JSON.stringify(google) });
    assert.equal(calls, 1);
});

test('rapid source switching and a reloaded stale preset do not mutate the shared address', async () => {
    const stored = structuredClone(google);
    const sent = [];
    const wrapped = createGuardedFetch(async (_, init) => sent.push(JSON.parse(init.body)), { enabled: () => true, baseUrl });
    for (const source of ['makersuite', 'openai', 'makersuite', 'custom', 'claude', 'makersuite']) {
        await wrapped(endpoint, { method: 'POST', body: JSON.stringify({ ...stored, chat_completion_source: source }) });
    }
    assert.deepEqual(sent.map(item => item.reverse_proxy), [
        'https://example.com/gemini', stored.reverse_proxy, 'https://example.com/gemini',
        stored.reverse_proxy, stored.reverse_proxy, 'https://example.com/gemini',
    ]);
    assert.deepEqual(stored, google);
});
