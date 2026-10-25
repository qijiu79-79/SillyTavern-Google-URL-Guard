export const REPOSITORY = 'https://github.com/qijiu79-79/SillyTavern-Google-URL-Guard';

export function isReleaseRemote(remote) {
    if (typeof remote !== 'string') return false;
    return remote.replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase() === REPOSITORY.toLowerCase();
}

export function installationTarget(moduleUrl, discovered) {
    const match = new URL(moduleUrl).pathname.match(/^\/scripts\/extensions\/third-party\/([\w.-]+)\/index\.js$/);
    if (!match || !Array.isArray(discovered)) throw new Error('无法确定安装位置，请使用酒馆的扩展管理。');
    const matches = discovered.filter(item => item?.name === `third-party/${match[1]}`);
    if (matches.length !== 1 || !['local', 'global'].includes(matches[0].type)) {
        throw new Error('没有找到唯一的插件安装记录，请检查扩展管理。');
    }
    return { extensionName: match[1], global: matches[0].type === 'global' };
}

function validateVersion(info) {
    if (!info?.currentCommitHash && !info?.remoteUrl) throw new Error('手动解压安装不能一键更新，请通过仓库链接安装。');
    if (!isReleaseRemote(info?.remoteUrl)) throw new Error('安装来源不是本插件的发布仓库，已停止更新。');
    if (!/^[a-f0-9]{40,64}$/i.test(info.currentCommitHash ?? '')
        || !info.currentBranchName || typeof info.isUpToDate !== 'boolean') {
        throw new Error('版本信息不完整，未进行更新。');
    }
    return info;
}

export class ExtensionUpdater {
    constructor({ request, moduleUrl, onState = () => {} }) {
        this.request = request;
        this.moduleUrl = moduleUrl;
        this.onState = onState;
        this.state = { phase: 'idle', message: '' };
        this.running = null;
        this.loadedCommit = null;
        this.uncertain = false;
    }

    set(phase, message) {
        this.state = { phase, message };
        this.onState(this.state);
    }

    run(update = false) {
        if (this.running) return this.running;
        this.running = this.perform(update).catch(error => {
            this.set('error', error.message || '更新失败，请查看酒馆服务器日志。');
        }).finally(() => { this.running = null; });
        return this.running;
    }

    async perform(update) {
        if (this.state.phase === 'updated') return;
        this.set('checking', '正在检查更新…');
        const target = installationTarget(this.moduleUrl, await this.request('/api/extensions/discover'));
        const before = validateVersion(await this.request('/api/extensions/version', target));
        if (this.loadedCommit === null) this.loadedCommit = before.currentCommitHash;
        if (this.loadedCommit !== before.currentCommitHash) {
            this.uncertain = false;
            this.set('updated', '安装文件已更新，等待安全刷新。');
            return;
        }
        if (this.uncertain) throw new Error('上次更新结果尚不确定，本次只检查，不重复下载；请稍后检查或查看服务器日志。');
        if (before.isUpToDate) {
            this.set('current', '已经是最新版本，无需刷新。');
            return;
        }
        if (!update) {
            this.set('available', '发现新版本，点击“一键更新”。');
            return;
        }
        this.set('updating', '正在通过酒馆下载更新…');
        this.uncertain = true;
        const result = await this.request('/api/extensions/update', target);
        if (!isReleaseRemote(result?.remoteUrl) || !/^[a-f0-9]{7,64}$/i.test(result?.shortCommitHash ?? '')
            || typeof result.isUpToDate !== 'boolean') throw new Error('更新返回信息不完整，请稍后检查更新状态。');
        const after = validateVersion(await this.request('/api/extensions/version', target));
        if (after.currentBranchName !== before.currentBranchName || !after.isUpToDate
            || !after.currentCommitHash.startsWith(result.shortCommitHash)) {
            throw new Error('更新后的版本核对未通过，请稍后检查；当前页面不会自动刷新。');
        }
        this.uncertain = false;
        if (after.currentCommitHash === before.currentCommitHash) {
            this.set('current', '文件没有变化，无需刷新。');
        } else {
            this.set('updated', '更新已下载并核对，等待安全刷新。');
        }
    }
}

/** Pure safety policy shared by the UI and tests. */
export function reloadBlockReason({ generating, pendingRequests, draft, editing, dialog, dirty, hidden, recentActivity }) {
    if (generating || pendingRequests) return '正在生成或请求尚未结束';
    if (draft) return '聊天框还有未发送的草稿';
    if (dialog || editing) return '仍在编辑内容或有弹窗打开';
    if (dirty) return '本页编辑过其他输入，请确认保存后点“刷新生效”';
    if (hidden) return '等待回到本页面';
    if (recentActivity) return '等待操作结束';
    return '';
}
