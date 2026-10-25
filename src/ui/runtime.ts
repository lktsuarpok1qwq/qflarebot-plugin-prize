export const runtime = String.raw`
function initRuntime({ bridge, syncDirty, validateRequest }) {
    const $ = id => document.getElementById(id);
    const state = { tab: 'pools', epoch: 0, control: null, pools: [], prizes: [], removedPrizes: new Set(), settingsBaseline: null, claim: null, draw: null, pending: null, busy: false, confirmBusy: false, focusAfter: null };
    const observer = new ResizeObserver(() => bridge.resize(Math.ceil($('content').getBoundingClientRect().height + 16)));
    observer.observe($('content'));
    bridge.setTitle('奖品中心');

    function toast(message, level = 'info') {
        if (bridge.embedded) {
            bridge.toast(message, level);

            return;
        }

        const node = document.createElement('div');
        node.className = 'toast';
        node.textContent = message;
        node.tabIndex = 0;
        node.onclick = () => node.remove();
        $('toasts').append(node);

        while ($('toasts').children.length > 3) { $('toasts').firstChild.remove(); }

        setTimeout(() => node.remove(), 5000);
    }

    function confirm(message, destructive = false) {
        if (state.confirmBusy) { return Promise.resolve(false); }

        state.confirmBusy = true;
        const dialog = $('confirm');
        const focus = document.activeElement;
        $('confirmBody').textContent = message;
        $('confirmYes').className = destructive ? 'destructive' : 'primary';
        dialog.showModal();
        $('confirmCancel').focus();

        return new Promise(resolve => {
            const end = value => {
                dialog.close();
                dialog.oncancel = null;
                dialog.onclick = null;
                $('confirmYes').onclick = null;
                $('confirmCancel').onclick = null;
                state.confirmBusy = false;
                $('confirmYes').className = 'primary';

                if (focus?.isConnected) { focus.focus({ preventScroll: true }); }

                resolve(value);
            };
            $('confirmYes').onclick = () => end(true);
            $('confirmCancel').onclick = () => end(false);
            dialog.oncancel = event => {
                event.preventDefault();
                end(false);
            };
            dialog.onclick = event => {
                if (event.target === dialog) {
                    const r = dialog.getBoundingClientRect();

                    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) { end(false); }
                }
            };
        });
    }

    function message(code) {
        return ({
            INSUFFICIENT_BALANCE: '积分不足', POOL_CLOSED: '奖池未开放', ADMISSION_LIMIT: '参与资格或库存不足',
            ADMISSION_CLOSED: '购买已暂停', ACCOUNT_NOT_FOUND: '积分账户不存在', NOT_FOUND: '未找到对应记录',
            SOURCE_NOT_REGISTERED: 'Points 来源尚未登记', SOURCE_DISABLED: 'Points 来源已停用', SOURCE_NOT_ALLOWED: 'Points 授权不足',
            CURSOR_EXPIRED: '列表已变化，请重新查询', CURSOR_INVALID: '翻页标识无效，请重新查询', CONFLICT: '记录版本已变化，请重新加载并保留草稿',
            INVALID_ARGUMENT: '请检查输入内容与范围', POINTS_NOT_READY: '请先在 Points 启用来源并配置完整权限',
            ARCHIVE_DISABLED: '请先开启 R2 归档设置', QUERY_WORK_LIMIT: '工作量超过上限，请缩小查询范围', QUERY_RANGE: '请选择最多31天的有效时段',
            QUERY_SNAPSHOT_CHANGED: '统计期间数据已变化，请重新查询', UNAVAILABLE: '服务暂不可用，请保留原操作号稍后核对',
            PRIZE_IN_USE: '库存正在占用，不能移除', PRIZE_REMOVED: '商品已移除，请刷新库存', PRIZE_NOT_READY: '绑定商品已移除或不存在，请重新选择',
            SCHEMA_NOT_READY: '正在自动准备，请稍后刷新', SCHEMA_INITIALIZING: '正在自动准备，请稍后刷新',
            SCHEMA_UNSUPPORTED: '数据结构不完整或不受支持，请保留数据并核查'
        })[code] || ('操作未完成（' + code + '）');
    }

    async function api(path, init) {
        const response = await bridge.fetch(path, init);
        const result = await response.json();

        if (!response.ok || result.ok === false) {
            if (result.code === 'CURSOR_EXPIRED' || result.code === 'CURSOR_INVALID') { document.dispatchEvent(new CustomEvent('prize:write', { detail: { scopes: [path.includes('/api/pools') ? (path.includes('view=prizes') ? 'stock' : 'pools') : path.includes('/api/claims') ? 'claims' : path.includes('/api/draws') ? 'records' : path.includes('/api/archives') ? 'archives' : 'operations'] } })); }

            throw Object.assign(new Error(message(result.code || 'UNAVAILABLE')), { result });
        }

        return result;
    }

    async function readRegion(id, task) {
        const region = $(id), display = region.style.display;
        const skeleton = node('div', undefined, 'loading-skeleton');
        const layout = id === 'reply-controls' ? 'editor' : ['poolList', 'stockList'].includes(id) ? 'cards' : 'rows';
        skeleton.dataset.layout = layout;
        skeleton.setAttribute('role', 'status');
        skeleton.setAttribute('aria-label', '正在加载');
        skeleton.append(...Array.from({ length: layout === 'rows' ? 3 : 2 }, () => node('div', undefined, 'skeleton-row')));
        region.before(skeleton);
        region.style.display = 'none';
        region.setAttribute('aria-busy', 'true');

        try { return await task(); } finally {
            skeleton.remove();
            region.style.display = display;
            region.setAttribute('aria-busy', 'false');
        }
    }

    let fieldSerial = 0;

    function fieldError(input, message) {
        if (!input.id) { input.id = 'prize-field-' + ++fieldSerial; }

        const id = input.id + '-error';
        let error = $(id);

        if (!error) {
            error = node('span', undefined, 'field-error');
            error.id = id;
            input.after(error);
        }

        error.textContent = message || '';
        error.hidden = !message;
        input.setAttribute('aria-invalid', String(!!message));
        const descriptions = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(value => value && value !== id);

        if (message) { descriptions.push(id); }

        if (descriptions.length) { input.setAttribute('aria-describedby', descriptions.join(' ')); } else { input.removeAttribute('aria-describedby'); }
    }

    function showPending() {
        const p = state.pending;
        $('pending').hidden = !p;

        if (p) { $('pendingText').textContent = p.request.action + ' · ' + p.request.target + ' · ' + p.request.operationId; }
    }

    function affects(region, event) {
        const detail = event.detail;

        if (detail?.scopes) { return detail.scopes.includes(region); }

        if (!detail?.action) { return true; }

        if (!detail.ok) { return region === 'operations'; }

        const scopes = {
            pool: ['pools', 'stock'], poolState: ['pools'], stockCreate: ['stock'], stock: ['stock'], stockRemove: ['stock'],
            fulfill: ['claims', 'records', 'stock', 'statistics'], cancel: ['claims', 'records', 'stock', 'statistics'],
            recover: ['claims', 'records', 'stock', 'statistics'], maintenance: ['claims', 'records', 'stock', 'archives', 'statistics'], archive: ['records', 'claims', 'archives'],
            messages: [], settings: [], enable: [], disable: []
        };

        return region === 'operations' || (scopes[detail.action] || []).includes(region);
    }

    function inputError(input) {
        const bytes = input.dataset.maxBytes && new TextEncoder().encode(input.value).length > Number(input.dataset.maxBytes);

        return bytes ? '最多 ' + input.dataset.maxBytes + ' 字节' : input.validity.valueMissing ? '请填写此项'
            : input.validity.rangeOverflow ? '不能大于 ' + input.max : input.validity.rangeUnderflow ? '不能小于 ' + input.min
                : !input.validity.valid ? '请填写有效的值' : '';
    }

    function requireField(input, description) {
        const error = description || inputError(input);
        fieldError(input, error);

        if (error) {
            state.focusAfter = input;
            throw new Error(error);
        }
    }

    function watchForm(form) {
        form.addEventListener('reset', () => {
            form.querySelectorAll('[aria-invalid=true]').forEach(input => fieldError(input, ''));
        });
        form.addEventListener('invalid', event => {
            fieldError(event.target, inputError(event.target));
        }, true);
        form.addEventListener('input', event => {
            const input = event.target;

            if (input.matches('input,textarea,select') && input.getAttribute('aria-invalid') === 'true') { fieldError(input, inputError(input)); }
        });
    }

    for (const id of ['stockForm', 'stockAdjustForm', 'settingsForm', 'recordSearch', 'claimSearch', 'statsForm', 'rejectedSearch', 'claimDetail', 'recoveryPanel', 'operationId']) { watchForm($(id)); }

    function setBusy(value) {
        state.busy = value;
        $('content').inert = value;
        $('content').setAttribute('aria-busy', String(value));
        syncDirty();
    }

    function invalidate() {
        state.epoch++;
        state.claim = null;
        state.draw = null;
        $('claimDetail').hidden = true;
        $('drawDetail').hidden = true;
        $('recoveryPanel').hidden = true;
        $('recoveryEmpty').hidden = false;
    }

    async function run(task) {
        if (state.busy) { return; }

        const origin = document.activeElement;
        setBusy(true);

        try { await task(); } catch (error) { toast(error.message, 'error'); } finally {
            setBusy(false);

            const requested = state.focusAfter, focus = requested || origin;
            state.focusAfter = null;

            if ((document.activeElement === document.body || requested && document.activeElement === origin) && focus?.isConnected && !focus.disabled) {
                focus.focus({ preventScroll: true });
            }
        }
    }

    async function write(action, target, version, params, message, done) {
        if (state.pending) {
            toast('请先核对原操作', 'warning');

            return;
        }

        validateRequest(action, target, version, params);

        const destructive = ['stockRemove', 'cancel', 'disable'].includes(action) || action === 'poolState' && ['CLOSED', 'ARCHIVED'].includes(params.state) || action === 'stock' && params.mode === 'RETIRE';

        if (!await confirm(message, destructive)) { return; }

        const request = { operationId: crypto.randomUUID(), action, target, expectedVersion: version, params };
        state.pending = { request, done, epoch: state.epoch };
        showPending();
        await sendPending();
    }

    async function sendPending() {
        const pending = state.pending;

        try {
            const response = await bridge.fetch('/api/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pending.request) });
            const result = await response.json();

            if (result.operationId !== pending.request.operationId || result.action !== pending.request.action || result.target !== pending.request.target || typeof result.ok !== 'boolean' || typeof result.code !== 'string') { throw new Error('响应不完整，请核对原操作'); }

            finishPending(result);
        } catch (error) { toast('结果尚未确认，请核对原操作', 'warning'); }
    }

    function validateOutcome(result, request) {
        if (typeof result?.ok !== 'boolean' || typeof result.code !== 'string') { throw new Error('原操作结果不完整'); }

        if (!result.ok) { return; }

        const codes = ({ enable: ['POINTS_READY', 'POINTS_NOT_READY'], maintenance: ['MAINTENANCE_ACCEPTED'], archive: ['MAINTENANCE_ACCEPTED'] })[request.action] || ['OK'];

        if (!codes.includes(result.code) || result.target !== request.target) { throw new Error('原操作结果不匹配'); }

        if (['messages', 'pool', 'poolState', 'stockCreate', 'stock', 'stockRemove', 'settings', 'enable', 'disable', 'fulfill', 'cancel', 'recover'].includes(request.action)
            && (!Number.isSafeInteger(result.version) || result.version !== request.expectedVersion + 1)) { throw new Error('原操作版本不完整'); }

        if (request.action === 'messages' && (!result.templates || result.templates.version !== result.version || JSON.stringify(result.templates.config) !== JSON.stringify(request.params.config))) { throw new Error('模板回执不匹配'); }

        if (['stockCreate', 'stock', 'stockRemove'].includes(request.action)) {
            const delta = request.action === 'stockRemove' ? 0 : request.params.amount * (request.action === 'stockCreate' || request.params.mode === 'ADD' ? 1 : -1);
            const s = result.stock;

            if (result.delta !== delta || !s || s.id !== request.target || s.version !== result.version
                || typeof s.bound !== 'boolean' || typeof s.name !== 'string' || !s.name.length || s.deleted !== (request.action === 'stockRemove' ? 1 : 0)
                || !['available', 'reserved', 'fulfilled'].every(key => Number.isSafeInteger(s[key]) && s[key] >= 0)) { throw new Error('原库存结果不完整或不匹配'); }

            if (request.action === 'stockCreate' && (s.name !== request.params.name || s.available !== request.params.amount || s.reserved !== 0 || s.fulfilled !== 0)) { throw new Error('原创建结果不匹配'); }
        }

        const states = ({ stockRemove: ['REMOVED'], pool: ['DRAFT', 'ACTIVE', 'PAUSED'], poolState: [request.params.state], fulfill: ['FULFILLED'], cancel: ['CANCELLED'], recover: ['ACCEPTED'], maintenance: ['QUEUED'], archive: ['QUEUED'] })[request.action];

        if (states && !states.includes(result.state)) { throw new Error('原操作状态不匹配'); }
    }

    function finishPending(result) {
        const p = state.pending;

        if (!p) { return; }

        validateOutcome(result, p.request);

        if (result.ok) {
            p.done?.(result);

            if (p.epoch === state.epoch) { toast('操作已记录', 'success'); }
        } else if (!result.ok && p.epoch === state.epoch) { toast(message(result.code), 'error'); }

        state.pending = null;
        showPending();
        state.epoch++;
        document.dispatchEvent(new CustomEvent('prize:write', { detail: { action: p.request.action, ok: result.ok } }));
    }

    async function verifyPending() {
        const p = state.pending;

        if (!p) { return; }

        const result = await api('/api/operations/' + encodeURIComponent(p.request.operationId));
        const r = result.data;

        if (!r || r.state === 'PENDING') {
            toast('原操作仍未确认，可重试原请求', 'warning');

            return;
        }

        if (r.state !== 'DONE' || r.operationId !== p.request.operationId || r.action !== p.request.action || r.target !== p.request.target || !r.outcome || typeof r.outcome.ok !== 'boolean' || typeof r.outcome.code !== 'string') { throw new Error('原操作收据不匹配'); }

        finishPending(r.outcome);
    }

    $('verify').onclick = () => run(verifyPending);
    $('retry').onclick = () => run(sendPending);

    function node(tag, text, className) {
        const element = document.createElement(tag);

        if (text !== undefined) { element.textContent = text; }

        if (className) { element.className = className; }

        return element;
    }

    function syncLoadButton(id, loaded, createId) {
        const control = $(id);
        control.querySelector('[data-load-label]').textContent = loaded ? '重新加载' : control.dataset.initialLabel;
        control.classList.toggle('primary', !loaded);

        if (createId) { $(createId).classList.toggle('primary', loaded); }
    }

    function button(label, handler) {
        const element = node('button', label);
        element.type = 'button';
        element.onclick = () => run(handler);

        return element;
    }

    return { $, state, bridge, toast, confirm, message, api, readRegion, fieldError, requireField, watchForm, run, write, verifyPending, sendPending, node, button, syncLoadButton, invalidate, affects };
}
`;
