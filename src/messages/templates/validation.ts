import { FIELDS } from './fields.js';
import type { MessageModule } from './fields.js';
import { configurationError } from './config.js';
import type { MessageConfiguration, TemplateError } from './config.js';
import { outputError } from './budget.js';
import { previewText } from './preview.js';

// 保存与业务准入使用相同的完整消息情景，片段可以为空，实际可达的正文必须有效。
export function createMessageValidation(fields: typeof FIELDS, basic: typeof configurationError, budget: typeof outputError, preview: typeof previewText) {
    return function messageError(module: MessageModule, config: MessageConfiguration, common: MessageConfiguration, selected?: string | readonly string[]): TemplateError | null {
        const roots = selected === undefined ? null : new Set((typeof selected === 'string' ? [selected] : selected).map(key => {
            while (fields[module][key]!.fragment) { key = fields[module][key]!.fragment!.message; }

            return key;
        }));
        const dependencies = roots ? new Set(roots) : null;

        if (dependencies) {
            let expanded = true;

            while (expanded) {
                expanded = false;

                for (const [key, field] of Object.entries(fields[module])) {
                    if (dependencies.has(key) || !field.fragment) { continue; }

                    if ([field.fragment, ...(field.fragment.also ?? [])].some(use => dependencies.has(use.message))) {
                        dependencies.add(key);
                        expanded = true;
                    }
                }
            }
        }

        const error = basic(module, config, dependencies ? [...dependencies] : undefined)
            ?? budget(module, config, common, roots ? [...roots] : undefined);

        if (error) { return error; }

        for (const [key, field] of Object.entries(fields[module])) {
            if (field.fragment || roots && !roots.has(key)) { continue; }

            // 仅复用本次完整校验已通过的展开预算，仍逐一验证所有正文情景。
            try { preview.validate(module, config, key, common); } catch {
                return { field: key, target: 'text', message: '“' + field.title + '”存在无效的完整消息，请检查正文和组成片段，不能只包含空值或留白', start: 0, end: config.replies[key]!.length };
            }
        }

        return null;
    };
}

export const messageError = createMessageValidation(FIELDS, configurationError, outputError, previewText);
