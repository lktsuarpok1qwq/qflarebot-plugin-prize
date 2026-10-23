import { FIELDS } from './fields.js';
import type { MessageModule } from './fields.js';
import { configurationError } from './config.js';
import type { MessageConfiguration, TemplateError } from './config.js';
import { outputError } from './budget.js';
import { previewText } from './preview.js';

// 保存与业务准入使用相同的完整消息情景，片段可以为空，实际可达的正文必须有效。
export function createMessageValidation(fields: typeof FIELDS, basic: typeof configurationError, budget: typeof outputError, preview: typeof previewText) {
    return function messageError(module: MessageModule, config: MessageConfiguration, common: MessageConfiguration, selected?: string): TemplateError | null {
        const error = basic(module, config, selected) ?? budget(module, config, common, selected);

        if (error) { return error; }

        let root = selected;

        while (root && fields[module][root]!.fragment) { root = fields[module][root]!.fragment!.message; }

        for (const [key, field] of Object.entries(fields[module])) {
            if (field.fragment || root && key !== root) { continue; }

            // 仅复用本次完整校验已通过的展开预算，仍逐一验证所有正文情景。
            try { preview.validate(module, config, key, common); } catch {
                return { field: key, target: 'text', message: '“' + field.title + '”存在无效的完整消息，请检查正文和组成片段，不能只包含空值或留白', start: 0, end: config.replies[key]!.length };
            }
        }

        return null;
    };
}

export const messageError = createMessageValidation(FIELDS, configurationError, outputError, previewText);
