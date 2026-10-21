import { button, keyboard } from '@qqbot/sdk';
import type { OutgoingMessage } from '@qqbot/sdk';
import type { Ctx } from '../../contracts.js';
import { DEFAULTS, escapeMarkdown, renderTemplate } from './config.js';
import type { MessageButton, MessageConfiguration } from './config.js';
import type { MessageModule } from './fields.js';

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
    commands: Partial<Record<MessageButton['action'], string>> = {}): OutgoingMessage {
    const text = piece(ctx, module, key, values, raw);

    if (!text.trim() || new TextEncoder().encode(text).length > 16000) { throw new Error('MESSAGE_OUTPUT_INVALID'); }

    const navigation = (ctx.config as { prizeNavigation?: { commands: Record<string, string>; userId: string; scene: string } })?.prizeNavigation;
    commands = { ...navigation?.commands, ...commands };
    const rows = configuration(ctx, module).buttons[key]!.map(row => row.flatMap(item => {
        if (item.action === 'link') { return [button.link(item.label, item.data!, { visitedLabel: item.label })]; }

        const command = item.action === 'command' ? item.data : commands[item.action];
        const publicAction = ['pool', 'records', 'prizes', 'history', 'buy'].includes(item.action)
            || module === 'pool' && key === 'activities' && item.action === 'next';

        return command ? [button.command(item.label, command, {
            enter: navigation?.scene === 'group' || item.action === 'details' ? false : item.enter, visitedLabel: item.label,
            style: ['buy', 'claim', 'continue', 'next'].includes(item.action) ? 1 : 0,
            permission: !publicAction && navigation?.userId ? { type: 0, specify_user_ids: [navigation.userId] } : { type: 2 }
        })] : [];
    })).filter(row => row.length);

    return { text, markdown: { content: text }, ...(rows.length ? { keyboard: keyboard(rows) } : {}) };
}
