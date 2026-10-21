import { FIELDS } from './fields.js';
import type { MessageModule } from './fields.js';
import type { MessageConfiguration } from './config.js';
import { escapeMarkdown, renderTemplate } from './config.js';

// 固定样例只用于浏览器预览，不读账户、不取随机结果。
export function createTemplatePreview(fields: typeof FIELDS, helpers: { escapeMarkdown: typeof escapeMarkdown; renderTemplate: typeof renderTemplate }) {
    const FIELDS = fields, { escapeMarkdown, renderTemplate } = helpers;

    return function previewText(module: MessageModule, config: MessageConfiguration, key: string, mode: string, scenario: string,
        markers: { start: string; end: string }): { text: string; root: string } {
        const fields = FIELDS[module];

        if (mode === 'layout') { return { text: config.replies[key]!, root: key }; }

        let root = key;
        const path = new Set<string>();

        while (fields[root]!.fragment) {
            if (path.has(root)) { throw new Error('模板片段循环'); }

            path.add(root);
            root = fields[root]!.fragment!.message;
        }

        const sample: Record<string, string> = {
            command: '/抽奖', prizeCommand: '/兑奖', pointsCommand: '/积分', name: '示例活动', cost: '1.00', reward: '5.00', net: '4.00',
            id: 'Ddemo', state: '已完成', label: '积分奖', probability: '25.0000', time: '2026-10-01T12:00:00Z', expires: '2026-10-02 20:00:00', detailsVersion: '0',
            continueCommand: '/抽奖 继续 Ddemo', purchaseCommand: '/抽奖 抽 demo', nextCommand: scenario === 'last' ? '' : '/抽奖 翻页 示例游标', message: config.words.INSUFFICIENT_BALANCE || '积分不足', code: 'INSUFFICIENT_BALANCE', action: '申请已记录'
        };

        if (module === 'prize') {
            sample.name = '示例奖品';
            sample.id = 'Pdemo';
            sample.nextCommand = scenario === 'last' ? '' : '/兑奖 翻页 示例游标';
        }

        const selectedCondition = fields[key]!.fragment?.when;
        const condition = scenario === 'normal' ? selectedCondition : scenario;
        const compose = (target: string, ancestors: string[] = []): string => {
            if (ancestors.includes(target)) { throw new Error('模板片段循环'); }

            const field = fields[target]!;
            const values: Record<string, string> = {};

            for (const variable of field.variables) {
                const candidates = Object.entries(fields).filter(([, f]) => f.fragment?.message === target && f.fragment.variable === variable || f.fragment?.also?.some(use => use.message === target && use.variable === variable));
                let chosen = candidates.find(([, f]) => f.fragment?.when === condition) ?? candidates.find(([, f]) => !f.fragment?.when);

                if (candidates.some(([name]) => name === key) && ancestors.includes(root)) { chosen = candidates.find(([name]) => name === key); }

                values[variable] = chosen ? compose(chosen[0], ancestors.concat(target)) : escapeMarkdown(sample[variable] ?? (() => { throw new Error('缺少样例：' + variable); })());
            }

            const text = renderTemplate(config.replies[target]!, values);

            return target === key && key !== root ? markers.start + text + markers.end : text;
        };

        return { text: compose(root), root };
    }
}

export const previewText = createTemplatePreview(FIELDS, { escapeMarkdown, renderTemplate });
