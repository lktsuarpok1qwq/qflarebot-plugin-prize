import type { Ctx } from '../../contracts.js';
import { ensure, meta } from '../../storage/db.js';
import { DEFAULTS, configurationError } from './config.js';
import type { MessageConfiguration } from './config.js';
import { MODULES } from './fields.js';
import type { MessageModule } from './fields.js';

export interface TemplateSnapshot { version: number; config: MessageConfiguration; }

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

function snapshot(saved: TemplateSnapshot | undefined, module: MessageModule): TemplateSnapshot {
    if (saved === undefined) { return { version: 0, config: structuredClone(DEFAULTS[module]) }; }

    ensure(saved && Number.isSafeInteger(saved.version) && saved.version > 0 && !configurationError(module, saved.config), 'TEMPLATES_INVALID');

    return saved;
}

export async function loadTemplates(ctx: Ctx, module: MessageModule): Promise<TemplateSnapshot> {
    return snapshot(stored((await meta(ctx)).settings)[module], module);
}

export async function messageContext(ctx: Ctx, module: MessageModule): Promise<Ctx> {
    const values = stored((await meta(ctx)).settings);
    // 一次读取，只校验和装载本入口与通用提示；其它模块配置不会增加当前命令的解析工作。
    const templates = Object.fromEntries([...new Set<MessageModule>(['common', module])].map(name => [name, snapshot(values[name], name).config]));

    return { ...ctx, config: { prizeMessages: templates } };
}
