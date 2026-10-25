import { button, keyboard } from '@qqbot/sdk';
import type { OutgoingMessage } from '@qqbot/sdk';
import type { Ctx } from '../../contracts.js';
import { DEFAULTS, escapeMarkdown, renderTemplate } from './config.js';
import type { MessageButton, MessageConfiguration } from './config.js';
import type { MessageModule } from './fields.js';
import { buttonRows, finalizeMarkdown } from './layout.js';
import type { MessageFacts } from './layout.js';

export function configuration(ctx: Ctx, module: MessageModule): MessageConfiguration {
    return (ctx.config as { prizeMessages?: Record<MessageModule, MessageConfiguration> })?.prizeMessages?.[module] ?? DEFAULTS[module];
}

export function word(ctx: Ctx, key: string): string {
    const value = configuration(ctx, 'common').words[key];

    if (value === undefined) { throw new Error('TEMPLATE_WORD_MISSING:' + key); }

    return value;
}

export function piece(ctx: Ctx, module: MessageModule, key: string, values: Record<string, string> = {}, raw: string[] = []): string {
    const template = configuration(ctx, module).replies[key];

    if (template === undefined) { throw new Error('TEMPLATE_MISSING:' + key); }

    return renderTemplate(template, Object.fromEntries(Object.entries(values).map(([name, value]) => [name, raw.includes(name) ? value : escapeMarkdown(value)])));
}

export function message(ctx: Ctx, module: MessageModule, key: string, values: Record<string, string> = {}, raw: string[] = [],
    commands: Partial<Record<MessageButton['action'], string>> = {}, facts: MessageFacts = {}): OutgoingMessage {
    const text = finalizeMarkdown(piece(ctx, module, key, values, raw));

    if (!text.replace(/\u200b/g, '').trim() || new TextEncoder().encode(text).length > 16000) { throw new Error('MESSAGE_OUTPUT_INVALID'); }

    const navigation = (ctx.config as { prizeNavigation?: { commands: Record<string, string>; userId: string; scene: string } })?.prizeNavigation;
    commands = { ...navigation?.commands, ...commands };
    const rows = buttonRows(module, configuration(ctx, module), key, commands, navigation?.scene ?? 'c2c', facts).map(row => row.map(item =>
        item.type === 'link' ? button.link(item.label, item.data, { visitedLabel: item.label }) : button.command(item.label, item.data, {
            enter: item.enter, visitedLabel: item.label, style: item.style,
            permission: item.personal && navigation?.userId ? { type: 0, specify_user_ids: [navigation.userId] } : { type: 2 }
        })));

    return { text, markdown: { content: text }, ...(rows.length ? { keyboard: keyboard(rows) } : {}) };
}
