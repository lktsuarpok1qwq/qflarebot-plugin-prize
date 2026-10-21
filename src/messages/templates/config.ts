import { FIELDS, MODULES, WORDS } from './fields.js';
import type { MessageModule } from './fields.js';

export interface MessageButton { label: string; action: 'command' | 'link' | 'continue' | 'next'; data?: string; enter?: boolean; }
export interface MessageConfiguration { replies: Record<string, string>; buttons: Record<string, MessageButton[][]>; words: Record<string, string>; }
export interface TemplateError { field: string; target: 'text' | 'buttons' | 'words'; message: string; start: number; end: number; row?: number; item?: number; control?: string; }

export const DEFAULTS: Record<MessageModule, MessageConfiguration> = Object.fromEntries(MODULES.map(module => [module, {
    replies: Object.fromEntries(Object.entries(FIELDS[module]).map(([key, value]) => [key, value.text])),
    buttons: Object.fromEntries(Object.entries(FIELDS[module]).filter(([, field]) => !field.fragment).map(([key, field]) => [key,
        field.actions?.length ? [[{ action: field.actions[0], label: field.actions[0] === 'continue' ? '继续处理' : '下一页', enter: false }]] : []])),
    words: module === 'common' ? Object.fromEntries(Object.entries(WORDS).map(([key, field]) => [key, field.text])) : {}
}])) as Record<MessageModule, MessageConfiguration>;

export function createTemplateTools(fields: typeof FIELDS, words: typeof WORDS) {
    const FIELDS = fields, WORDS = words;

    function templateError(value: unknown, variables: readonly string[], required: readonly string[] = []): { message: string; start: number; end: number } | null {
        if (typeof value !== 'string' || new TextEncoder().encode(value).length > 4000) { return { message: '正文最多4000字节', start: 0, end: 0 }; }

        const invalid = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.exec(value);

        if (invalid) { return { message: '正文包含不支持的控制字符', start: invalid.index, end: invalid.index + 1 }; }

        const used = new Set<string>();
        const pattern = /\{\{([^{}]*)\}\}|\{\{|\}\}/g;

        for (const match of value.matchAll(pattern)) {
            if (match[1] === undefined || !variables.includes(match[1]) || value[match.index - 1] === '{' || value[match.index + match[0].length] === '}') {
                return { message: '变量无效，请使用当前位置提供的变量', start: match.index, end: match.index + match[0].length };
            }

            used.add(match[1]);
        }

        const absent = required.find(name => !used.has(name));

        return absent ? { message: '请保留 {{' + absent + '}}', start: 0, end: value.length } : null;
    }

    function safeHttpUrl(value: unknown): value is string {
        if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s<>"'\u0000-\u001f]/.test(value)) { return false; }

        try {
            const url = new URL(value);

            return !!url.hostname && !url.username && !url.password;
        } catch { return false; }
    }

    function configurationError(module: MessageModule, value: unknown, selected?: string): TemplateError | null {
        const exact = (input: unknown, keys: string[]): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input)
            && Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
        const problem = (field: string, target: TemplateError['target'], message: string): TemplateError => ({ field, target, message, start: 0, end: 0 });
        const keys = Object.keys(FIELDS[module]), messages = keys.filter(key => !FIELDS[module][key]!.fragment);

        if (!exact(value, ['replies', 'buttons', 'words']) || !exact(value.replies, keys) || !exact(value.buttons, messages)
            || !exact(value.words, module === 'common' ? Object.keys(WORDS) : [])) { return problem(keys[0]!, 'text', '请提交本模块的完整模板配置'); }

        const config = value as unknown as MessageConfiguration;

        if (new TextEncoder().encode(JSON.stringify(config)).length > 16000) { return problem(keys[0]!, 'text', '本模块模板配置最多16000字节'); }

        for (const key of keys.filter(key => selected === undefined || key === selected)) {
            const field = FIELDS[module][key]!;
            const error = templateError(config.replies[key], field.variables, field.required);

            if (error) { return { field: key, target: 'text', ...error }; }

            if (!field.fragment && !config.replies[key]!.trim()) { return problem(key, 'text', '完整消息不能为空'); }

            if (field.fragment) { continue; }

            const rows = config.buttons[key];

            if (!Array.isArray(rows) || rows.length > 5 || rows.some(row => !Array.isArray(row) || row.length < 1 || row.length > 5)) { return problem(key, 'buttons', '按钮最多5行，每行1～5个'); }

            for (const [row, items] of rows.entries()) {
                for (const [item, button] of items.entries()) {
                    const fail = (message: string, control: string) => ({ ...problem(key, 'buttons', message), row, item, control });

                    if (!button || typeof button !== 'object' || Object.keys(button).some(name => !['label', 'action', 'data', 'enter'].includes(name))
                        || typeof button.label !== 'string' || !button.label.trim() || [...button.label].length > 10 || /[\u0000-\u001f{}]/.test(button.label)) { return fail('按钮文字为1～10字，不使用变量', 'label'); }

                    if (!['command', 'link', ...field.actions ?? []].includes(button.action)) { return fail('按钮功能不适用于此消息', 'action'); }

                    if (button.action === 'link') {
                        if (!safeHttpUrl(button.data) || button.enter !== undefined) { return fail('请填写 HTTP 或 HTTPS 链接', 'data'); }
                    } else {
                        if (typeof button.enter !== 'boolean') { return fail('请选择点击方式', 'enter'); }

                        if (button.action === 'command' ? typeof button.data !== 'string' || !button.data.trim() || new TextEncoder().encode(button.data).length > 300 || /[\u0000-\u001f{}]/.test(button.data) : button.data !== undefined) { return fail('命令为单行固定文字，原业务参数由程序生成', 'data'); }
                    }
                }
            }

            for (const action of field.actions ?? []) {
                if (rows.flat().filter(button => button.action === action).length !== 1) { return problem(key, 'buttons', '请保留且仅保留一个' + (action === 'continue' ? '原业务继续' : '原列表翻页') + '按钮'); }
            }
        }

        for (const [key, word] of Object.entries(config.words)) {
            if (typeof word !== 'string' || !word.trim() || new TextEncoder().encode(word).length > 500 || /[{}\u0000-\u001f]/.test(word)) { return { ...problem('error', 'words', '提示用语须为非空单行文字，最多500字节'), control: key }; }

            if (!Object.hasOwn(WORDS, key)) { return problem('error', 'words', '提示用语类型无效'); }
        }

        return null;
    }

    function renderTemplate(template: string, values: Record<string, string>): string {
        return template.replace(/\{\{([^{}]*)\}\}/g, (_, key: string) => {
            if (!Object.hasOwn(values, key)) { throw new Error('TEMPLATE_VALUE_MISSING:' + key); }

            return values[key]!;
        });
    }

    function escapeMarkdown(value: string): string { return value.replace(/[\\`*_\[\]()~>#|!]/g, '\\$&'); }

    return { templateError, configurationError, safeHttpUrl, renderTemplate, escapeMarkdown };
}

export const { templateError, configurationError, safeHttpUrl, renderTemplate, escapeMarkdown } = createTemplateTools(FIELDS, WORDS);
