import { FIELDS } from './fields.js';
import type { MessageModule } from './fields.js';
import type { MessageButton, MessageConfiguration } from './config.js';

export type MessageCommands = Partial<Record<MessageButton['action'], string>>;
export interface PreviewMarkers { start: string; end: string; }
export interface RenderedButton { label: string; type: 'link' | 'command'; data: string; enter?: boolean; style: 0 | 1; personal: boolean; }
export interface MessageFacts { claimState?: string; itemCount?: number; buyAllowed?: boolean; }

// 浏览器与发送端共用纯函数；不依赖 DOM、SDK 上下文或业务查询。
export function createMessageLayout(fields: typeof FIELDS) {
    function finalizeMarkdown(source: string, markers?: PreviewMarkers): string {
        const clean = (line: string) => markers ? line.split(markers.start).join('').split(markers.end).join('') : line;
        const normalized = source.replace(/\r\n?/g, '\n');

        if (!clean(normalized).trim()) { return normalized; }

        const lines = normalized.split('\n'), output: string[] = [];
        const block = (line: string) => /^(?:#{1,2}\s|>\s?|\s*(?:[-*]|\d+\.)\s|\s*\*\s*\*\s*\*\s*$)/.test(clean(line));

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index]!;

            if (clean(line).trim() || clean(lines[index - 1] ?? '').includes('\u200b') || clean(lines[index + 1] ?? '').includes('\u200b')) {
                output.push(line);
                continue;
            }

            // 保留块结构的空行边界，用户要求的可见留白由独立占位行表达。
            if (index > 0 && block(lines[index - 1]!)) { output.push(''); }

            output.push(line + '\u200b');

            if (index + 1 < lines.length && block(lines[index + 1]!)) { output.push(''); }
        }

        return output.join('\n');
    }

    function joinItems(module: MessageModule, key: string, items: string[]): string {
        const separator = fields[module][key]?.fragment?.separator;

        if (separator === undefined) { throw new Error('TEMPLATE_LIST_SEPARATOR_MISSING:' + key); }

        return items.join(separator);
    }

    function actionCommands(module: MessageModule, key: string, commands: MessageCommands, scene: string, facts: MessageFacts): MessageCommands {
        const values = { ...commands };
        const goods = module === 'pool' && key === 'goodsWon';
        const detail = module === 'prize' && key === 'detail';
        values.claim = scene === 'c2c' && facts.claimState === 'PENDING' && (goods || detail || module === 'prize' && key === 'list' && facts.itemCount === 1) ? values.claim : '';
        values.details = scene === 'c2c' && facts.claimState === 'CLAIMED' && (goods || detail || module === 'prize' && key === 'actionResult') ? values.details : '';
        values.buy = facts.buyAllowed ? values.buy : '';

        if (scene === 'group') {
            values.prizes = '';
            values.history = '';
            values.account = '';
        }

        return values;
    }

    function buttonRows(module: MessageModule, config: MessageConfiguration, key: string, commands: MessageCommands, scene: string, facts: MessageFacts): RenderedButton[][] {
        commands = actionCommands(module, key, commands, scene, facts);

        return (config.buttons[key] ?? []).map(row => row.flatMap<RenderedButton>(item => {
            if (item.action === 'link') { return [{ label: item.label, type: 'link' as const, data: item.data!, style: 0 as const, personal: false }]; }

            const command = item.action === 'command' ? item.data : commands[item.action];
            const publicAction = ['pool', 'records', 'prizes', 'history', 'buy'].includes(item.action)
                || module === 'pool' && key === 'activities' && item.action === 'next';

            return command ? [{
                label: item.label, type: 'command' as const, data: command,
                enter: scene === 'group' || item.action === 'details' ? false : item.enter,
                style: (['buy', 'claim', 'continue', 'next'].includes(item.action) ? 1 : 0) as 0 | 1, personal: !publicAction
            }] : [];
        })).filter(row => row.length);
    }

    return { finalizeMarkdown, joinItems, actionCommands, buttonRows };
}

export const { finalizeMarkdown, joinItems, actionCommands, buttonRows } = createMessageLayout(FIELDS);
