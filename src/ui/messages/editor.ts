import { AWARD_ICONS, FIELDS, MODULES, VARIABLE_HELP, WORDS } from '../../messages/templates/fields.js';
import { DEFAULTS, createTemplateTools } from '../../messages/templates/config.js';
import { createMarkdown } from '../../messages/templates/markdown.js';
import { createTemplatePreview } from '../../messages/templates/preview.js';
import { createMessageLayout } from '../../messages/templates/layout.js';
import { createOutputBudget } from '../../messages/templates/budget.js';
import { createMessageValidation } from '../../messages/templates/validation.js';
import { EDITOR_COMMANDS, createEditorNavigation } from '../../messages/templates/navigation.js';
import { messageComposition } from './composition.js';
import { TEXT_EDITOR_SCRIPT } from './text.js';
import { IMAGE_EDITOR_SCRIPT } from './images.js';
import { messageButtons } from './buttons.js';

const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export function messagesUI(): string {
    return [
        "function initMessages({ confirm, $, api, fieldError, node, readRegion, run, state, syncLoadButton, toast, write }) {",
        'const FIELDS=' + json(FIELDS) + ', MODULES=' + json(MODULES) + ', DEFAULTS=' + json(DEFAULTS) + ', WORDS=' + json(WORDS) + ', ICONS=' + json(AWARD_ICONS) + ', EDITOR_COMMANDS=' + json(EDITOR_COMMANDS) + ', VARIABLE_HELP=' + json(VARIABLE_HELP) + ';',
        'const {awardIcon,configurationError,templateError,renderTemplate,escapeMarkdown,safeHttpUrl,commandUrl,safeCommandUrl}=(' + createTemplateTools.toString() + ' )(FIELDS,WORDS,ICONS);',
        'const navigation=(' + createEditorNavigation.toString() + ')(FIELDS,EDITOR_COMMANDS);',
        'const messageLayout=(' + createMessageLayout.toString() + ')(FIELDS);',
        'const outputError=(' + createOutputBudget.toString() + ')(FIELDS,messageLayout.finalizeMarkdown,messageLayout.separatorFor,awardIcon,messageLayout.fragmentCandidates);',
        'const renderQQMarkdown=(' + createMarkdown.toString() + ')(safeHttpUrl,safeCommandUrl,messageLayout.finalizeMarkdown);',
        'const previewText=(' + createTemplatePreview.toString() + ')(FIELDS,{escapeMarkdown,renderTemplate,commandUrl,layout:messageLayout,defaultCommon:DEFAULTS.common,outputError,awardIcon,navigation});',
        'const messageError=(' + createMessageValidation.toString() + ')(FIELDS,configurationError,outputError,previewText);',
        TEXT_EDITOR_SCRIPT, IMAGE_EDITOR_SCRIPT, messageButtons, messageComposition,
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
    const composition = createMessageComposition({ FIELDS, ICONS, messageLayout, awardIcon, navigation, current, edit, changed, $, node, createTextTools });
    const textTools = createTextTools($('reply-body'), () => {
        if (active) {
            active.draft.replies[active.key] = $('reply-body').value;
            composition.related();
            active.serial++;
            preview();
        }
    });
    textTools.retainSelection($('reply-toolbar'));
    textTools.retainSelection($('reply-variables'));
    const tools = [
        ['一级标题', '# ', '', '标题', false, true], ['二级标题', '## ', '', '标题', false, true],
        ['加粗', '**', '**'], ['斜体', '*', '*'], ['粗斜体', '***', '***'], ['删除线', '~~', '~~'],
        ['引用', '> ', '', '引用', false, true], ['无序列表', '- ', '', '条目', false, true], ['有序列表', '1. ', '', '条目', false, true], ['嵌套列表', '    - ', '', '条目', false, true],
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
        syncLoadButton('reply-load', !!model?.baseline);
        $('reply-save').disabled = state.busy || !dirty(model) || !!state.pending;
        $('reply-discard').disabled = state.busy || !dirty(model);
        $('reply-default').disabled = state.busy || !model?.baseline;
    }

    function remember() {
        if (!active?.rendered) { return; }

        const body = $('reply-body');
        const separators = Object.fromEntries([...$('reply-separator-fields').querySelectorAll('textarea')].map(input => [input.dataset.separator, { start: input.selectionStart, end: input.selectionEnd, top: input.scrollTop }]));
        active.branches.set(active.command, active.key);
        active.positions.set(active.command + '/' + active.key, { start: body.selectionStart, end: body.selectionEnd, top: body.scrollTop, direction: body.selectionDirection, scenario: $('reply-scenario').value, separators });
    }

    function common(model) {
        return model.module === 'common' ? model.draft : model.related.common.config;
    }

    function validation(model, selected) {
        const root = selected ? navigation.context(model.module, model.command, selected).root : undefined;
        const expanded = (selected ? configurationError(model.module, model.draft, selected) : null)
            || messageError(model.module, model.draft, common(model), root);

        if (expanded || model.module !== 'common') { return expanded; }

        for (const [module, snapshot] of Object.entries(model.related)) {
            const error = messageError(module, snapshot.config, model.draft);

            if (error) { return { ...error, field: 'error', message: names[module] + '：' + error.message }; }
        }

        return null;
    }

    function notify(module, snapshot) {
        for (const model of models.values()) {
            if (model.related?.[module] && snapshot.version >= model.related[module].version) {
                model.related[module] = clone(snapshot);

                if (visible(model)) { preview(); }
            }
        }
    }

    function scenarios() {
        const model = active;
        let choices;

        try { choices = previewText.scenarios(model.module, model.draft, model.key, common(model), model.command); } catch { choices = FIELDS[model.module][model.key].scenarios || [['normal', '默认']]; }

        if (!choices.length) { choices = [['normal', '默认']]; }

        const before = $('reply-scenario').value || model.positions.get(model.command + '/' + model.key)?.scenario;
        $('reply-scenario').replaceChildren();
        choices.forEach(([value, label]) => option($('reply-scenario'), value, label));
        $('reply-scenario').value = choices.some(([v]) => v === before) ? before : choices[0][0];
        $('reply-scenario-field').hidden = choices.length === 1;
    }

    function preview() {
        if (!active?.draft) { return; }

        scenarios();
        const model = active, field = FIELDS[model.module][model.key], error = validation(model, model.key);
        const textError = error?.field === model.key && error.target === 'text';
        $('reply-body').setAttribute('aria-invalid', String(!!textError));
        $('reply-error').hidden = error?.target !== 'text';
        $('reply-error').textContent = error?.target === 'text' ? error.message + (textError ? '（第 ' + model.draft.replies[model.key].slice(0, error.start).split('\n').length + ' 行）' : '') : '';
        $('reply-words-fields').querySelectorAll('input').forEach(input => fieldError(input, error?.target === 'words' && error.control === input.dataset.word ? error.message : ''));
        buttons.validate(error?.target === 'buttons' ? error : null);
        $('reply-separator-fields').querySelectorAll('textarea').forEach(input => fieldError(input, error?.target === 'separator' && error.field === input.dataset.separator ? error.message : ''));
        $('reply-icon-fields').querySelectorAll('input').forEach(input => fieldError(input, error?.target === 'icon' && error.control === input.dataset.icon ? error.message : ''));
        const token = '\uE000' + crypto.randomUUID(), markers = { start: token + 'S\uE001', end: token + 'E\uE001' };

        try {
            const result = previewText(model.module, model.draft, model.key, model.mode, $('reply-scenario').value, markers, common(model), model.command);
            $('reply-preview-text').innerHTML = renderQQMarkdown(result.text, model.mode === 'sample' && field.fragment ? markers : undefined);
            $('reply-preview-title').textContent = '即时预览 · ' + (model.mode === 'sample' || !field.fragment ? '完整消息' : '当前片段');
            $('reply-preview-buttons').replaceChildren();

            for (const row of result.buttons) {
                const line = node('div', undefined, 'actions');
                row.forEach(item => {
                    const b = node('button', item.label);
                    b.dataset.messageStyle = String(item.style);
                    b.className = 'reply-message-button';
                    b.title = item.type === 'link' ? '打开链接' : item.enter ? '直接发送命令' : '填入输入框';
                    b.disabled = true;
                    line.append(b);
                });

                if (line.children.length) { $('reply-preview-buttons').append(line); }
            }

            restoreImages();
            $('reply-preview-notice').textContent = model.mode === 'layout' ? '当前正文，变量保持原样' : field.fragment && !$('reply-preview-text').querySelector('mark,.sample-highlight') ? '此片段为空或当前完整消息未引用它' : dirty(model) ? '预览当前草稿，保存后用于发送；数据为固定示例' : '预览已保存模板；示例值会由实际数据替换';
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
                const detail = node('details', undefined, 'reply-variable-composition'), description = node('p', '按当前片段草稿及实际列表分隔规则组成。以下仅供参考，不增加正文可用变量', 'muted');
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
            input.id = 'reply-word-' + key;
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
        const fields = FIELDS[model.module], field = fields[key];
        const context = navigation.context(model.module, model.command, key);
        model.command = context.id;
        $('reply-group').replaceChildren();
        EDITOR_COMMANDS[model.module].forEach(command => option($('reply-group'), command.id, command.title));
        $('reply-group').value = context.id;
        $('reply-group-field').hidden = EDITOR_COMMANDS[model.module].length === 1;
        const branches = navigation.entries(model.module, context.id);
        $('reply-key').replaceChildren();
        branches.forEach(({ key, root }) => option($('reply-key'), key, fields[key].title + (fields[key].fragment ? ' · ' + fields[root].title : ' · 完整消息')));
        $('reply-key').value = key;
        $('reply-key-field').hidden = branches.length === 1;
        $('reply-body-label').textContent = '模板正文' + (EDITOR_COMMANDS[model.module].length === 1 ? ' · ' + context.title : '') + (branches.length === 1 ? ' · ' + field.title : '');
        $('reply-body').value = model.draft.replies[key];
        const uses = EDITOR_COMMANDS[model.module].filter(command => navigation.entries(model.module, command.id).some(item => item.key === key));
        $('reply-uses').textContent = '当前：' + context.title + ' → ' + field.title + (uses.length > 1 ? '。共享模板，保存后同时用于：' + uses.map(use => use.title).join('；') : '');
        $('reply-buttons-section').hidden = !!field.fragment;
        composition.render();
        variables(field);
        buttons.draw();
        words();
        $('reply-scenario').value = '';
        preview();
        model.rendered = true;
        const position = model.positions.get(model.command + '/' + key), body = $('reply-body');

        if (position) {
            body.setSelectionRange(Math.min(position.start, body.value.length), Math.min(position.end, body.value.length), position.direction);
            body.scrollTop = position.top;
        }
    }

    function show(module) {
        if (active) { remember(); }

        currentModule = module;

        if (!models.has(module)) { models.set(module, { module, command: null, key: Object.keys(FIELDS[module])[0], baseline: null, draft: null, version: 0, serial: 0, positions: new Map(), branches: new Map(), mode: 'sample', rendered: false }); }

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

        const response = await readRegion('reply-controls', () => api('/api/messages/' + model.module)), result = response.data;

        if (!Number.isSafeInteger(result?.version) || result.version < 0 || configurationError(model.module, result.config)) { throw new Error('模板响应不完整，草稿已保留'); }

        const dependencies = model.module === 'common' ? ['pool', 'prize'] : ['common'];

        if (!result.related || dependencies.some(module => !Number.isSafeInteger(result.related[module]?.version) || result.related[module].version < 0 || configurationError(module, result.related[module].config))) { throw new Error('关联文案响应不完整，草稿已保留'); }

        if (model.serial !== serial) { return; }

        model.baseline = clone(result.config);
        model.draft = clone(result.config);
        model.version = result.version;
        model.related = clone(result.related);
        notify(model.module, { version: model.version, config: model.baseline });

        if (visible(model)) {
            $('reply-controls').hidden = false;
            edit(model.key, false);
        }
    });
    $('reply-key').onchange = () => edit($('reply-key').value);
    $('reply-group').onchange = () => {
        remember();
        active.command = $('reply-group').value;
        edit(active.branches.get(active.command) || navigation.entries(active.module, active.command)[0].key, false);
    };
    $('reply-body').oninput = () => {
        active.draft.replies[active.key] = $('reply-body').value;
        composition.related();
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

        if (!await confirm('恢复“' + FIELDS[model.module][key].title + '”的默认草稿？' + (model.module === 'common' && key === 'error' ? '包含状态与错误用语，' : '') + (composition.iconKeys(model) ? '包含四种奖项类型图标，' : '') + (composition.separatorKeys(model).length ? '包含当前项目间隔，' : '') + '保存后生效')) { return; }

        model.draft.replies[key] = DEFAULTS[model.module].replies[key];
        composition.separatorKeys(model).forEach(key => composition.setSeparator(key, FIELDS[model.module][key].fragment.separator, model));

        if (composition.iconKeys(model)) { delete model.draft.icons; }

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
        const model = active, error = validation(model);

        if (error) {
            edit(error.field);

            if (error.target === 'words') { $('reply-words').open = true; }

            const input = error.target === 'text' ? $('reply-body') : error.target === 'separator' ? $('reply-separator-fields').querySelector('[data-separator="' + error.field + '"]') : error.target === 'icon' ? $('reply-icon-fields').querySelector('[data-icon="' + error.control + '"]') : error.target === 'words' ? $('reply-words-fields').querySelector('[data-word="' + error.control + '"]') : buttons.validate(error);
            state.focusAfter = input;
            input?.focus();

            if (input === $('reply-body') || error.target === 'separator') { input?.setSelectionRange(error.start, error.end); }

            throw new Error(error.message);
        }

        const submitted = clone(model.draft), serial = model.serial;
        await write('messages', model.module, model.version, { config: submitted }, '保存本模块全部模板修改？', result => {
            if (model.version > result.version) { return; }

            model.version = result.version;
            model.baseline = clone(result.templates.config);
            notify(model.module, { version: model.version, config: model.baseline });

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
        , 'return { ...messageEditor, configurationError };', '}'
    ].join('\n');
}
