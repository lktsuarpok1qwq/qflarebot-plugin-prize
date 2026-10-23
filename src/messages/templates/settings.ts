import type { Ctx, Meta } from '../../contracts.js';
import { ensure, meta } from '../../storage/db.js';
import { DEFAULTS, configurationError } from './config.js';
import type { MessageConfiguration } from './config.js';
import { MODULES } from './fields.js';
import type { MessageModule } from './fields.js';
import { messageError } from './validation.js';

export interface TemplateSnapshot { version: number; config: MessageConfiguration; }
export interface EditorTemplates extends TemplateSnapshot { related: Partial<Record<MessageModule, TemplateSnapshot>>; }

export function moduleName(value: unknown): MessageModule {
    ensure(typeof value === 'string' && MODULES.includes(value as MessageModule));

    return value as MessageModule;
}

function stored(settings: string): Partial<Record<MessageModule, TemplateSnapshot>> {
    const messages = JSON.parse(settings).messages;

    if (messages === undefined) { return {}; }

    ensure(messages && typeof messages === 'object' && !Array.isArray(messages)
        && Object.keys(messages).every(key => MODULES.includes(key as MessageModule)), 'TEMPLATES_INVALID');

    return messages;
}

function snapshot(saved: TemplateSnapshot | undefined, module: MessageModule, validate = true): TemplateSnapshot {
    if (saved === undefined) { return { version: 0, config: structuredClone(DEFAULTS[module]) }; }

    ensure(saved && Number.isSafeInteger(saved.version) && saved.version > 0 && (!validate || !configurationError(module, saved.config)), 'TEMPLATES_INVALID');

    return saved;
}

export async function loadTemplates(ctx: Ctx, module: MessageModule): Promise<TemplateSnapshot> {
    return snapshot(stored((await meta(ctx)).settings)[module], module);
}

export function templateSnapshots(settings: string, modules: readonly MessageModule[]): Partial<Record<MessageModule, TemplateSnapshot>> {
    const values = stored(settings);

    return Object.fromEntries(modules.map(name => [name, snapshot(values[name], name)]));
}

export async function loadEditorTemplates(ctx: Ctx, module: MessageModule, initial?: Meta): Promise<EditorTemplates> {
    const modules: MessageModule[] = module === 'common' ? [...MODULES] : ['common', module];
    const values = templateSnapshots((initial ?? await meta(ctx)).settings, modules);
    const related = Object.fromEntries(Object.entries(values).filter(([name]) => name !== module));

    return { ...values[module]!, related };
}

export async function messageContext(ctx: Ctx, module: MessageModule, control?: Meta): Promise<Ctx> {
    const values = stored((control ?? await meta(ctx)).settings);
    // 一次读取，只校验和装载本入口与通用提示；其它模块不参与当前命令的模板校验和装载。
    const templates = Object.fromEntries([...new Set<MessageModule>(['common', module])].map(name => [name, snapshot(values[name], name, false).config]));
    ensure(!messageError('common', templates.common!, templates.common!) && (module === 'common' || !messageError(module, templates[module]!, templates.common!)), 'TEMPLATES_INVALID');

    return { ...ctx, config: { prizeMessages: templates } };
}
