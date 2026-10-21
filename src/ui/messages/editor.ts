import { FIELDS, MODULES, VARIABLE_HELP, WORDS } from '../../messages/templates/fields.js';
import { DEFAULTS, createTemplateTools } from '../../messages/templates/config.js';
import { createMarkdown } from '../../messages/templates/markdown.js';
import { createTemplatePreview } from '../../messages/templates/preview.js';
import { TEXT_EDITOR_SCRIPT } from './text.js';
import { IMAGE_EDITOR_SCRIPT } from './images.js';
import { messageButtons } from './buttons.js';

const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
export const messagesUI = [
    'const FIELDS=' + json(FIELDS) + ', MODULES=' + json(MODULES) + ', DEFAULTS=' + json(DEFAULTS) + ', WORDS=' + json(WORDS) + ', VARIABLE_HELP=' + json(VARIABLE_HELP) + ';',
    'const {configurationError,templateError,renderTemplate,escapeMarkdown,safeHttpUrl,commandUrl,safeCommandUrl}=(' + createTemplateTools.toString() + ')(FIELDS,WORDS);',
    'const renderQQMarkdown=(' + createMarkdown.toString() + ')(safeHttpUrl,safeCommandUrl);',
    'const previewText=(' + createTemplatePreview.toString() + ')(FIELDS,{escapeMarkdown,renderTemplate,commandUrl});',
    TEXT_EDITOR_SCRIPT, IMAGE_EDITOR_SCRIPT, messageButtons,
    String.raw`
const messageEditor = (() => {
    const models = new Map();
    const names = { pool: '奖池', prize: '兑奖', common: '通用提示' };
    const panels = { pool: 'pools', prize: 'claims', common: 'settings' };
    let active = null, currentModule = null;
    const clone = value => structuredClone(value);
    const current = () => active;
    const visible = model => active === model && !$('replies').hidden;
    const dirty = model => !!model?.baseline && JSON.stringify(model.draft) !== JSON.stringify(model.baseline);
    const option = (target, value, label) => {
        const o = node('option', label);
        o.value = value;
        target.append(o);
    };
    const restoreImages = createPreviewImages($('reply-preview-text'));
    const buttons = createMessageButtons(current, changed);
    const textTools = createTextTools($('reply-body'), () => {
        if (active) {
            active.draft.replies[active.key] = $('reply-body').value;
            active.serial++;
            preview();
        }
    });
    textTools.retainSelection($('reply-toolbar'));
    textTools.retainSelection($('reply-variables'));
    const tools = [
        ['一级标题', '# ', '', '标题', false, true], ['二级标题', '## ', '', '标题', false, true],
        ['加粗', '**', '**'], ['斜体', '*', '*'], ['粗斜体', '***', '***'], ['删除线', '~~', '~~'],
        ['引用', '> ', '', '引用', false, true], ['无序列表', '- ', '', '条目', false, true], ['有序列表', '1. ', '', '条目', false, true], ['嵌套列表', '  - ', '', '条目', false, true],
        ['链接', '[', '](https://example.com)'], ['图片', '![', '](https://example.com/image.png)', '图片说明'], ['分割线', '\n***\n', '', '', true]
    ];
    tools.forEach(([label, ...args]) => {
        const b = node('button', label);
        b.type = 'button';
        b.onclick = () => textTools.insert(...args);
        $('reply-toolbar').append(b);
    });

    function sync() {
        $('replies').setAttribute('aria-busy', String(state.busy));
        restoreImages();
        const model = active;
        $('reply-status').textContent = state.busy && model ? '正在处理…' : !model?.baseline ? '尚未加载' : dirty(model) ? '有未保存的修改' : '暂无未保存修改';
        $('reply-load').textContent = model?.baseline ? '重新加载' : '加载模板';
        $('reply-save').disabled = state.busy || !dirty(model) || !!state.pending;
        $('reply-discard').disabled = state.busy || !dirty(model);
        $('reply-default').disabled = state.busy || !model?.baseline;
    }

    function remember() {
        if (!active?.rendered) { return; }

        const body = $('reply-body');
        active.positions.set(active.key, { start: body.selectionStart, end: body.selectionEnd, top: body.scrollTop, direction: body.selectionDirection, scenario: $('reply-scenario').value });
    }

    function scenarios() {
        const model = active;
        let choices;

        try { choices = previewText.scenarios(model.module, model.draft, model.key); } catch { choices = FIELDS[model.module][model.key].scenarios || [['normal', '默认']]; }

        const before = $('reply-scenario').value || model.positions.get(model.key)?.scenario;
        $('reply-scenario').replaceChildren();
        choices.forEach(([value, label]) => option($('reply-scenario'), value, label));
        $('reply-scenario').value = choices.some(([v]) => v === before) ? before : choices[0][0];
        $('reply-scenario-field').hidden = choices.length === 1;
    }

    function preview() {
        if (!active?.draft) { return; }

        scenarios();
        const model = active, field = FIELDS[model.module][model.key], error = configurationError(model.module, model.draft, model.key);
        const textError = error?.field === model.key && error.target === 'text';
        $('reply-body').setAttribute('aria-invalid', String(!!textError));
        $('reply-error').hidden = !error;
        $('reply-error').textContent = error ? error.message + (textError ? '（第 ' + model.draft.replies[model.key].slice(0, error.start).split('\n').length + ' 行）' : '') : '';
        $('reply-words-fields').querySelectorAll('input').forEach(input => input.setAttribute('aria-invalid', String(error?.target === 'words' && error.control === input.dataset.word)));
        buttons.validate(error?.target === 'buttons' ? error : null);
        const token = '\uE000' + crypto.randomUUID(), markers = { start: token + 'S\uE001', end: token + 'E\uE001' };

        try {
            const result = previewText(model.module, model.draft, model.key, model.mode, $('reply-scenario').value, markers);
            $('reply-preview-text').innerHTML = renderQQMarkdown(result.text, model.mode === 'sample' && field.fragment ? markers : undefined);
            $('reply-preview-title').textContent = '即时预览 · ' + (model.mode === 'sample' || !field.fragment ? '完整消息' : '当前片段');
            $('reply-preview-buttons').replaceChildren();

            for (const row of model.draft.buttons[result.root] || []) {
                const line = node('div', undefined, 'actions');
                row.forEach(item => {
                    if (result.hiddenActions?.includes(item.action)) { return; }

                    if (item.action === 'next' && ['empty', 'last'].includes($('reply-scenario').value)) { return; }

                    const b = node('button', item.label);
                    b.disabled = true;
                    line.append(b);
                });

                if (line.children.length) { $('reply-preview-buttons').append(line); }
            }

            restoreImages();
            $('reply-preview-notice').textContent = model.mode === 'layout' ? '当前正文，变量保持原样' : field.fragment && !$('reply-preview-text').querySelector('mark,.sample-highlight') ? '此片段为空或当前完整消息未引用它' : '固定示例，仅预览，不发送消息';
        } catch (error) {
            $('reply-preview-text').textContent = error.message;
            $('reply-preview-buttons').replaceChildren();
        }

        $('reply-sample').setAttribute('aria-pressed', String(model.mode === 'sample'));
        $('reply-layout').setAttribute('aria-pressed', String(model.mode === 'layout'));
        sync();
    }

    function changed() {
        if (active) {
            active.serial++;
            preview();
        }
    }

    function variables(field) {
        $('reply-variables').replaceChildren();
        field.variables.forEach(name => {
            const wrapper = node('div', undefined, 'reply-variable'), b = node('button', '{{' + name + '}}'), help = node('span', VARIABLE_HELP[name], 'hint');
            help.id = 'reply-variable-' + name;
            b.setAttribute('aria-describedby', help.id);
            b.onclick = () => textTools.insert('{{' + name + '}}', '', '', true);
            wrapper.append(b, help);
            const parts = Object.entries(FIELDS[active.module]).filter(([, f]) => f.fragment?.message === active.key && f.fragment.variable === name || f.fragment?.also?.some(use => use.message === active.key && use.variable === name));

            if (parts.length) {
                const detail = node('details', undefined, 'reply-variable-composition'), description = node('p', '按当前片段草稿组成；多个列表项以空行连接。以下仅供参考，不增加正文可用变量', 'muted');
                const fields = node('dl');
                const seen = new Set();
                parts.forEach(([, f]) => f.variables.forEach(variable => {
                    if (!seen.has(variable)) {
                        fields.append(node('dt', '{{' + variable + '}}'), node('dd', VARIABLE_HELP[variable]));
                        seen.add(variable);
                    }
                }));
                detail.append(node('summary', '查看组成'), description, fields);
                wrapper.append(detail);
            }

            $('reply-variables').append(wrapper);
        });
        $('reply-variables').hidden = !field.variables.length;
        $('reply-hint').textContent = field.variables.length ? '点击变量插入到光标处' + (field.required.length ? '；必须保留：' + field.required.map(n => '{{' + n + '}}').join('、') : '') : '此模板没有可用变量，直接填写文字或 Markdown';
    }

    function words() {
        $('reply-words').hidden = active.module !== 'common';
        $('reply-words-fields').replaceChildren();

        if (active.module !== 'common') { return; }

        Object.entries(WORDS).forEach(([key, info]) => {
            const label = node('label', info.title), input = node('input');
            input.dataset.word = key;
            input.value = active.draft.words[key];
            input.oninput = () => {
                active.draft.words[key] = input.value;
                changed();
            };
            label.append(input);
            $('reply-words-fields').append(label);
        });
    }

    function edit(key, preserve = true) {
        if (preserve) { remember(); }

        const model = active;
        model.key = key;
        const fields = FIELDS[model.module], field = fields[key], groups = [...new Set(Object.values(fields).map(f => f.group))];
        $('reply-group').replaceChildren();
        groups.forEach(group => option($('reply-group'), group, group));
        $('reply-group').value = field.group;
        const branches = Object.keys(fields).filter(k => fields[k].group === field.group);
        $('reply-key').replaceChildren();
        branches.forEach(key => option($('reply-key'), key, fields[key].title));
        $('reply-key').value = key;
        $('reply-key-field').hidden = branches.length === 1;
        $('reply-group').parentElement.hidden = groups.length === 1;
        $('reply-body-label').textContent = '模板正文' + (branches.length === 1 ? ' · ' + field.title : '');
        $('reply-body').value = model.draft.replies[key];
        $('reply-uses').textContent = field.fragment ? '共享片段 · 用于“' + [field.fragment.message, ...(field.fragment.also || []).map(use => use.message)].map(key => fields[key].title).join('、') + '”，保存后全部引用生效' : '用于“' + field.title + '”消息';
        $('reply-buttons-section').hidden = !!field.fragment;
        variables(field);
        buttons.draw();
        words();
        $('reply-scenario').value = '';
        preview();
        model.rendered = true;
        const position = model.positions.get(key), body = $('reply-body');

        if (position) {
            body.setSelectionRange(Math.min(position.start, body.value.length), Math.min(position.end, body.value.length), position.direction);
            body.scrollTop = position.top;
        }
    }

    function show(module) {
        if (active) { remember(); }

        currentModule = module;

        if (!models.has(module)) { models.set(module, { module, key: Object.keys(FIELDS[module])[0], baseline: null, draft: null, version: 0, serial: 0, positions: new Map(), mode: 'sample', rendered: false }); }

        active = models.get(module);
        document.querySelectorAll('[data-panel]').forEach(panel => panel.hidden = true);
        $('replies').hidden = false;
        $('reply-module-title').textContent = names[module];
        $('reply-controls').hidden = !active.baseline;

        if (active.baseline) { edit(active.key, false); }

        sync();
        $('reply-load').focus({ preventScroll: true });
    }

    function close() {
        remember();
        $('replies').hidden = true;
        active = null;
        document.querySelector('[data-panel=' + panels[currentModule] + ']').hidden = false;
    }

    $('reply-back').onclick = close;
    document.querySelectorAll('[data-messages]').forEach(b => b.onclick = () => show(b.dataset.messages));
    $('reply-load').onclick = () => run(async () => {
        const model = active, serial = model.serial;

        if (dirty(model) && !await confirm('重新加载会丢弃本模块全部模板草稿，是否继续？')) { return; }

        const response = await api('/api/messages/' + model.module), result = response.data;

        if (!Number.isSafeInteger(result?.version) || result.version < 0 || configurationError(model.module, result.config)) { throw new Error('模板响应不完整，草稿已保留'); }

        if (model.serial !== serial) { return; }

        model.baseline = clone(result.config);
        model.draft = clone(result.config);
        model.version = result.version;

        if (visible(model)) {
            $('reply-controls').hidden = false;
            edit(model.key, false);
        }
    });
    $('reply-key').onchange = () => edit($('reply-key').value);
    $('reply-group').onchange = () => edit(Object.keys(FIELDS[active.module]).find(key => FIELDS[active.module][key].group === $('reply-group').value));
    $('reply-body').oninput = () => {
        active.draft.replies[active.key] = $('reply-body').value;
        changed();
    };
    $('reply-body').addEventListener('select', remember);
    $('reply-body').addEventListener('scroll', remember);
    $('reply-scenario').onchange = preview;
    $('reply-sample').onclick = () => {
        active.mode = 'sample';
        preview();
    };
    $('reply-layout').onclick = () => {
        active.mode = 'layout';
        preview();
    };
    $('reply-default').onclick = () => run(async () => {
        const model = active, key = model.key;

        if (!await confirm('恢复“' + FIELDS[model.module][key].title + '”的默认草稿？' + (model.module === 'common' && key === 'error' ? '包含状态与错误用语，' : '') + '保存后生效')) { return; }

        model.draft.replies[key] = DEFAULTS[model.module].replies[key];

        if (model.draft.buttons[key]) { model.draft.buttons[key] = clone(DEFAULTS[model.module].buttons[key]); }

        if (model.module === 'common' && key === 'error') { model.draft.words = clone(DEFAULTS.common.words); }

        model.serial++;

        if (visible(model)) { edit(key); }
    });
    $('reply-discard').onclick = () => run(async () => {
        const model = active;

        if (await confirm('撤销本模块全部未保存修改？')) {
            model.draft = clone(model.baseline);
            model.serial++;

            if (visible(model)) { edit(model.key); }
        }
    });
    $('reply-save').onclick = () => run(async () => {
        const model = active, error = configurationError(model.module, model.draft);

        if (error) {
            edit(error.field);

            if (error.target === 'words') { $('reply-words').open = true; }

            const input = error.target === 'text' ? $('reply-body') : error.target === 'words' ? $('reply-words-fields').querySelector('[data-word="' + error.control + '"]') : buttons.validate(error);
            input?.focus();

            if (input === $('reply-body')) { input.setSelectionRange(error.start, error.end); }

            throw new Error(error.message);
        }

        const submitted = clone(model.draft), serial = model.serial;
        await write('messages', model.module, model.version, { config: submitted }, '保存本模块全部模板修改？', result => {
            if (model.version > result.version) { return; }

            model.version = result.version;
            model.baseline = clone(result.templates.config);

            if (model.serial === serial) { model.draft = clone(result.templates.config); }

            if (visible(model)) { edit(model.key); }
        });
    });
    const observer = new ResizeObserver(() => {
        const height = $('reply-body').getBoundingClientRect().height;

        if (height) { $('replies').style.setProperty('--reply-editor-height', height + 'px'); }
    });
    observer.observe($('reply-body'));

    return {
        sync, leave: () => {
            if (active) { remember(); }

            active = null;
            $('replies').hidden = true;
        }
    };
})();
`
].join('\n');
