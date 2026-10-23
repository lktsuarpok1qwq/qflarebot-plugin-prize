import { FIELDS } from './fields.js';
import type { MessageModule } from './fields.js';
import { awardIcon } from './config.js';
import type { MessageConfiguration, TemplateError } from './config.js';
import { finalizeMarkdown, separatorFor, fragmentCandidates } from './layout.js';

export function createOutputBudget(fields: typeof FIELDS, format: typeof finalizeMarkdown, separatorFor: typeof import('./layout.js').separatorFor, iconFor: typeof awardIcon, fragments: typeof fragmentCandidates) {
    return function outputError(module: MessageModule, config: MessageConfiguration, common: MessageConfiguration, selected?: string): TemplateError | null {
        const bytes = (text: string) => new TextEncoder().encode(text).length;
        const escaped = (text: string) => bytes(text.replace(/[\\`*_\[\]()~>#|!]/g, '\\$&'));
        const largestWord = (prefix: string[]) => Math.max(0, ...Object.entries(common.words).filter(([key]) => prefix.some(p => key.startsWith(p))).map(([, value]) => escaped(value)));
        const primitive: Record<string, number> = {
            name: 240, label: 160, cost: 16, reward: 16, net: 17, id: 96, probability: 13, icon: Math.max(...['NONE', 'POINTS', 'VIRTUAL_MANUAL', 'PHYSICAL'].map(type => escaped(iconFor(config, type)))),
            command: 600, prizeCommand: 600, pointsCommand: 600, purchaseCommand: 600, nextCommand: 600,
            prizeUrl: 1024, purchaseUrl: 1024, probabilityUrl: 1024,
            time: 24, code: 64,
            state: largestWord(['claim_', 'draw_', 'pool_', 'processing', 'review']),
            message: largestWord([''])
        };
        const cache = new Map<string, number>();
        const separators = new Map<string, number>();

        function separatorBytes(scope: MessageModule, name: string): number {
            const key = scope + '/' + name;

            if (!separators.has(key)) { separators.set(key, bytes(format(separatorFor(scope, scope === 'common' ? common : config, name)))); }

            return separators.get(key)!;
        }

        function size(target: string, scope = module): number {
            const id = scope + '/' + target;

            if (cache.has(id)) { return cache.get(id)!; }

            cache.set(id, Infinity);
            const source = (scope === 'common' ? common : config).replies[target]!;
            const rendered = format(source);
            let total = bytes(rendered);

            for (const match of rendered.matchAll(/\{\{([^{}]*)\}\}/g)) {
                const variable = match[1]!;
                let bound: number;

                if (scope === 'pool' && target === 'probabilityItem' && variable === 'reward') { bound = Math.max(240, size('recordReward')); } else {
                    const children = fragments(scope, target, variable);

                    if (children.length) {
                        bound = Math.max(...children.map(([name, field]) => {
                            const count = variable === 'items' && !field.fragment?.when ? (target === 'probability' ? 20 : 5) : 1;
                            const separator = count > 1 ? separatorBytes(scope, name) : 0;

                            return count * size(name, scope) + Math.max(0, count - 1) * separator;
                        }));
                    } else { bound = primitive[variable] ?? Infinity; }
                }

                total += bound - bytes(match[0]) + 8;
            }

            cache.set(id, total);

            return total;
        }

        let root = selected;

        while (root && fields[module][root]!.fragment) { root = fields[module][root]!.fragment!.message; }

        for (const [key, field] of Object.entries(fields[module])) {
            if (!field.fragment && (!root || key === root) && size(key) > 16000) {
                return { field: key, target: 'text', message: '“' + field.title + '”展开后可能超过16000字节，请缩短正文或组成片段', start: 0, end: config.replies[key]!.length };
            }
        }

        return null;
    };
}

export const outputError = createOutputBudget(FIELDS, finalizeMarkdown, separatorFor, awardIcon, fragmentCandidates);
