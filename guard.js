/** Only remove complete, terminal /v1 path segments. Preserve query/fragment bytes. */
export function stripTrailingV1(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    try {
        const url = new URL(trimmed);
        if (!['http:', 'https:'].includes(url.protocol)) return value;
        if (!/(?:\/v1)+\/*$/.test(url.pathname)) return value;
    } catch {
        return value;
    }
    const boundary = trimmed.search(/[?#]/);
    const base = boundary < 0 ? trimmed : trimmed.slice(0, boundary);
    const suffix = boundary < 0 ? '' : trimmed.slice(boundary);
    const parts = base.match(/^(https?:\/\/[^/]+)(\/.*)$/i);
    if (!parts) return value;
    const fixed = parts[1] + parts[2].replace(/(?:\/v1)+\/*$/, '');
    return fixed === base ? value : fixed + suffix;
}

/** Request source, never model name or the current UI selection, is authoritative. */
export function normalizeGooglePayload(payload) {
    if (!payload || Array.isArray(payload) || typeof payload !== 'object'
        || payload.chat_completion_source !== 'makersuite') return payload;
    const fixed = stripTrailingV1(payload.reverse_proxy);
    return fixed === payload.reverse_proxy ? payload : { ...payload, reverse_proxy: fixed };
}

export function isChatEndpoint(input, init, baseUrl) {
    const isRequest = input instanceof Request;
    if (String(init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase() !== 'POST') return false;
    try {
        const url = new URL(isRequest ? input.url : String(input), baseUrl);
        return url.origin === new URL(baseUrl).origin
            && /^\/api\/backends\/chat-completions\/(status|generate)\/?$/.test(url.pathname);
    } catch {
        return false;
    }
}

/** Narrow fallback for status requests and extensions bypassing the generation event.
 * No extra request, retry, credential access, response wrapping or settings mutation.
 */
export function createGuardedFetch(originalFetch, { enabled, baseUrl, onRepair = () => {} }) {
    return async function guardedFetch(input, init) {
        let nextInput = input;
        let nextInit = init;
        if (enabled() && isChatEndpoint(input, init, baseUrl)) {
            try {
                const explicitBody = init && Object.hasOwn(init, 'body');
                let body = explicitBody ? init.body : undefined;
                if (!explicitBody && input instanceof Request
                    && input.headers.get('content-type')?.toLowerCase().includes('application/json')) {
                    body = await input.clone().text();
                }
                if (typeof body === 'string') {
                    const payload = JSON.parse(body);
                    const fixed = normalizeGooglePayload(payload);
                    if (fixed !== payload) {
                        const options = { ...init, body: JSON.stringify(fixed) };
                        if (input instanceof Request) {
                            nextInput = new Request(input, options);
                            nextInit = undefined;
                        } else {
                            nextInit = options;
                        }
                        // Reporting must never stop or repeat the actual request.
                        try { onRepair(); } catch { /* No sensitive payload logging. */ }
                    }
                }
            } catch { /* Unsupported/invalid body: preserve the original request. */ }
        }
        // Deliberately outside the catch: never retry a failed generation.
        return originalFetch(nextInput, nextInit);
    };
}
