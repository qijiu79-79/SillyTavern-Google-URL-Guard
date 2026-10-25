import { createGuardedFetch, normalizeGooglePayload, stripTrailingV1, isChatEndpoint } from './guard.js';
import { ExtensionUpdater, reloadBlockReason } from './updater.js';

const VERSION = '1.0.0';
const SETTING = 'google_url_guard';
let cleanup = null;

function start() {
    if (cleanup) return;
    const context = () => SillyTavern.getContext();
    const ctx = context();
    const events = ctx.eventTypes ?? ctx.event_types;
    const settings = ctx.extensionSettings[SETTING] ??= { enabled: true };
    let active = true;
    let repairs = 0;
    let pendingRequests = 0;
    let generating = false;
    let groupGenerating = false;
    let dirty = false;
    let lastActivity = 0;
    let reloadTimer = null;
    let panel = null;
    const subscriptions = [];
    const listeners = [];
    const enabled = () => active && settings.enabled !== false;
    const listen = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        listeners.push(() => target.removeEventListener(type, handler, options));
    };
    const subscribe = (event, handler) => {
        if (!event) return;
        ctx.eventSource.on(event, handler);
        subscriptions.push(() => ctx.eventSource.removeListener(event, handler));
    };
    const reportRepair = () => {
        repairs++;
        renderStatus();
    };
    const previousFetch = window.fetch;
    const guarded = createGuardedFetch(previousFetch.bind(window), {
        enabled, baseUrl: location.href, onRepair: reportRepair,
    });
    const wrappedFetch = async (input, init) => {
        const tracked = active && isChatEndpoint(input, init, location.href);
        if (tracked) pendingRequests++;
        try { return await guarded(input, init); }
        finally { if (tracked) pendingRequests--; }
    };
    window.fetch = wrappedFetch;
    subscribe(events.CHAT_COMPLETION_SETTINGS_READY, payload => {
        if (!enabled()) return;
        const fixed = normalizeGooglePayload(payload);
        if (fixed !== payload) {
            payload.reverse_proxy = fixed.reverse_proxy;
            reportRepair();
        }
    });
    subscribe(events.GENERATION_STARTED, (_type, _options, dryRun) => { if (!dryRun) generating = true; });
    subscribe(events.GENERATION_ENDED, () => { generating = false; });
    subscribe(events.GENERATION_STOPPED, () => { generating = false; });
    subscribe(events.GROUP_WRAPPER_STARTED, () => { groupGenerating = true; });
    subscribe(events.GROUP_WRAPPER_FINISHED, () => { groupGenerating = false; });

    async function request(path, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), path.endsWith('/update') ? 90000 : 45000);
        try {
            const response = await fetch(path, {
                method: body ? 'POST' : 'GET',
                headers: context().getRequestHeaders(),
                credentials: 'same-origin',
                cache: 'no-store',
                signal: controller.signal,
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            if (!response.ok) throw new Error(`酒馆返回 HTTP ${response.status}，请检查服务器日志后重试。`);
            return await response.json();
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('请求超时，服务器可能仍在处理；请稍后检查更新状态。');
            throw error;
        } finally { clearTimeout(timeout); }
    }
    const updater = new ExtensionUpdater({ request, moduleUrl: import.meta.url, onState: renderUpdate });

    function renderStatus() {
        if (!panel) return;
        const current = context();
        const oai = current.chatCompletionSettings;
        let message = '待命中，其他源不受影响。';
        if (!enabled()) message = '已关闭。';
        else if (current.mainApi === 'openai' && oai?.chat_completion_source === 'makersuite') {
            message = stripTrailingV1(oai.reverse_proxy) !== oai.reverse_proxy
                ? '谷歌源已保护，末尾 /v1 会在发送时去掉。'
                : '谷歌源已保护，地址正常。';
        }
        panel.querySelector('[data-status]').textContent = `${message} 本页已修正 ${repairs} 次。`;
    }

    function hostState() {
        const isVisible = element => Boolean(element && element.getClientRects().length);
        const focus = document.activeElement;
        const stream = context().streamingProcessor;
        return {
            generating: generating || groupGenerating || Boolean(stream && !stream.isFinished),
            pendingRequests,
            draft: Boolean(document.getElementById('send_textarea')?.value?.trim()),
            editing: Boolean(focus?.matches('input,textarea,select,[contenteditable="true"]') && !panel?.contains(focus))
                || [...document.querySelectorAll('.mes_edit_textarea')].some(isVisible),
            dialog: [...document.querySelectorAll('dialog[open], .popup:not([hidden])')].some(isVisible),
            dirty,
            hidden: document.hidden,
            recentActivity: Date.now() - lastActivity < 2500,
        };
    }

    function renderUpdate() {
        if (!panel) return;
        const state = updater.state;
        const busy = ['checking', 'updating'].includes(state.phase);
        panel.querySelector('[data-update]').disabled = busy || state.phase === 'updated';
        panel.querySelector('[data-update]').textContent = {
            checking: '检查中…', updating: '更新中…', available: '一键更新',
            current: '已是最新 · 再查', updated: '已更新', error: '重新检查',
        }[state.phase] ?? '检查更新';
        panel.querySelector('[data-reload]').hidden = state.phase !== 'updated';
        let message = state.message;
        if (state.phase === 'updated') {
            const reason = reloadBlockReason(hostState());
            message += reason ? ` 自动刷新暂缓：${reason}。` : ' 即将自动刷新。';
            if (!reloadTimer && active) reloadTimer = setTimeout(attemptReload, 1500);
        }
        panel.querySelector('[data-update-status]').textContent = message;
    }

    function attemptReload() {
        reloadTimer = null;
        if (!active || updater.state.phase !== 'updated') return;
        if (reloadBlockReason(hostState())) renderUpdate();
        else location.reload();
    }

    function mount() {
        if (!active || panel) return;
        const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
        if (!host) return;
        panel = document.createElement('div');
        panel.id = 'google-url-guard';
        panel.className = 'extension_container';
        panel.innerHTML = `
          <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b>谷歌地址守卫 <small>v${VERSION}</small></b>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
              <label class="checkbox_label"><input type="checkbox" data-enabled>启用自动修正</label>
              <p data-status role="status" aria-live="polite"></p>
              <p class="gug-muted">不改预设，不影响 OAI；地址框仍显示 /v1 也无需手动删除。</p>
              <div class="gug-actions">
                <button type="button" class="menu_button" data-update>检查更新</button>
                <button type="button" class="menu_button" data-reload hidden>刷新生效</button>
              </div>
              <p data-update-status role="status" aria-live="polite"></p>
            </div>
          </div>`;
        host.append(panel);
        const toggle = panel.querySelector('[data-enabled]');
        toggle.checked = enabled();
        listen(toggle, 'change', () => {
            settings.enabled = toggle.checked;
            context().saveSettingsDebounced();
            renderStatus();
        });
        listen(panel.querySelector('[data-update]'), 'click', () => updater.run(updater.state.phase === 'available'));
        listen(panel.querySelector('[data-reload]'), 'click', () => {
            const state = hostState();
            // A manual click may acknowledge edited settings, but never discard a chat draft or interrupt generation.
            const reason = reloadBlockReason({ ...state, dirty: false, recentActivity: false });
            if (reason) {
                panel.querySelector('[data-update-status]').textContent = `暂不刷新：${reason}。`;
                return;
            }
            if (dirty && !window.confirm('请确认其他面板中编辑的内容已经保存。现在刷新应用更新？')) return;
            if (updater.state.phase === 'updated') location.reload();
        });
        renderStatus();
        renderUpdate();
    }
    for (const event of [events.APP_READY, events.APP_INITIALIZED]) subscribe(event, mount);
    for (const event of [events.CHATCOMPLETION_SOURCE_CHANGED, events.CONNECTION_PROFILE_LOADED,
        events.OAI_PRESET_CHANGED_AFTER, events.MAIN_API_CHANGED, events.SETTINGS_UPDATED]) subscribe(event, renderStatus);
    listen(document, 'input', event => {
        if (event.target?.id === 'openai_reverse_proxy') renderStatus();
        if (event.isTrusted && !panel?.contains(event.target) && event.target?.id !== 'send_textarea') dirty = true;
    });
    listen(document, 'keydown', () => { lastActivity = Date.now(); }, true);
    listen(document, 'pointerdown', () => { lastActivity = Date.now(); }, true);
    listen(document, 'visibilitychange', renderStatus);
    // Also supports enable/re-enable after APP_READY has already fired.
    mount();
    cleanup = () => {
        active = false;
        if (window.fetch === wrappedFetch) window.fetch = previousFetch;
        // If another extension wrapped us later, the inactive wrapper becomes a pass-through.
        subscriptions.forEach(off => off());
        listeners.forEach(off => off());
        clearTimeout(reloadTimer);
        panel?.remove();
        cleanup = null;
    };
}

export function onDisable() { cleanup?.(); }
export function onEnable() { start(); }
start();
