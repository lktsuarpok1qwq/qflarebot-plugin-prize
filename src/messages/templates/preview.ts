import { FIELDS } from './fields.js';
import type { MessageModule } from './fields.js';
import { DEFAULTS, commandUrl, escapeMarkdown, renderTemplate } from './config.js';
import type { MessageConfiguration } from './config.js';
import { createMessageLayout } from './layout.js';
import type { MessageCommands, PreviewMarkers, RenderedButton } from './layout.js';
import { outputError } from './budget.js';

// 固定样例只用于浏览器预览，不读账户、不取随机结果。
export function createTemplatePreview(fields: typeof FIELDS, helpers: {
    escapeMarkdown: typeof escapeMarkdown; renderTemplate: typeof renderTemplate; commandUrl: typeof commandUrl;
    layout: ReturnType<typeof createMessageLayout>; defaultCommon: MessageConfiguration; outputError: typeof outputError;
}) {
    const FIELDS = fields, { commandUrl, escapeMarkdown, renderTemplate, layout, defaultCommon, outputError } = helpers;

    function previewText(module: MessageModule, config: MessageConfiguration, key: string, mode: string, scenario: string,
        markers: PreviewMarkers, common: MessageConfiguration = module === 'common' ? config : defaultCommon): {
            text: string; root: string; buttons: RenderedButton[][]; hiddenActions: string[];
        } {
        const fields = FIELDS[module];
        let root = key;
        const path = new Set<string>();

        while (fields[root]!.fragment) {
            if (path.has(root)) { throw new Error('模板片段循环'); }

            path.add(root);
            root = fields[root]!.fragment!.message;
        }

        const condition = scenario === 'normal' ? fields[key]!.fragment?.when ?? (root === 'actionResult' ? 'claimed' : '') : scenario;
        const group = condition === 'group' || module === 'common' && root === 'privateOnly';
        const scene = group ? 'group' : 'c2c';
        const state = ['terminal', 'expired', 'claimed'].includes(condition) ? condition : 'pending';
        const claimState = state === 'terminal' ? 'FULFILLED' : state === 'expired' ? 'EXPIRED' : state === 'claimed' ? 'CLAIMED' : 'PENDING';
        const word = (key: string) => {
            if (common.words[key] === undefined) { throw new Error('缺少通用用语：' + key); }

            return common.words[key]!;
        };
        const sampleDraw = 'D4845cd5fd64d48b4801f13a7c4959536', samplePrize = 'P4845cd5fd64d48b4801f13a7c4959536';
        const next = !['empty', 'last'].includes(condition);
        const sample: Record<string, string> = {
            purchaseUrl: commandUrl('/抽奖 抽 demo 2', !group), probabilityUrl: commandUrl('/抽奖 奖项 demo', !group),
            continueUrl: commandUrl('/抽奖 继续 ' + sampleDraw, !group), detailUrl: commandUrl('/兑奖 ' + samplePrize),
            claimUrl: commandUrl('/兑奖 领取 ' + samplePrize), detailsUrl: commandUrl('/兑奖 资料 ' + samplePrize + ' 0 ', false),
            command: '/抽奖', prizeCommand: '/兑奖', pointsCommand: '/积分', name: '示例活动', cost: '1', reward: '5', net: '4',
            id: sampleDraw, state: word('draw_SETTLED'), label: '积分奖', icon: '🪙', probability: '25', time: '2026-10-01T12:00:00Z',
            expires: '2026-10-02 20:00:00', detailsVersion: '0', continueCommand: '/抽奖 继续 ' + sampleDraw,
            purchaseCommand: '/抽奖 抽 demo 2', nextCommand: next ? '/抽奖 翻页 示例游标' : '',
            message: word('INSUFFICIENT_BALANCE'), code: 'INSUFFICIENT_BALANCE', action: word('actionClaim'), notice: '', instructions: ''
        };

        if (root === 'activities') { sample.nextCommand = next ? '/抽奖 奖池 示例游标' : ''; }

        if (module === 'prize') {
            sample.name = '示例奖品';
            sample.id = samplePrize;
            sample.nextCommand = next ? '/兑奖 翻页 示例游标' : '';
        }

        if (module === 'pool' && root === 'probability') { sample.state = word('pool_ACTIVE'); }

        if (module === 'pool' && (root === 'pending' || condition === 'pending')) { sample.state = word(condition === 'review' ? 'review' : 'processing'); }

        if (module === 'prize' || root === 'goodsWon') { sample.state = word('claim_' + claimState); }

        if (root === 'goodsWon') {
            sample.name = '示例奖品';
            sample.instructions = group ? renderTemplate(common.replies.privateOnly!, {
                prizeCommand: escapeMarkdown('/兑奖 ' + (claimState === 'PENDING' ? '领取 ' : '') + samplePrize)
            }) : '';
        }

        const commands: MessageCommands = {
            pool: '/抽奖', records: '/抽奖 记录', prizes: '/兑奖', history: '/兑奖 记录', account: '/积分 开户',
            next: sample.nextCommand, continue: root === 'pending' ? sample.continueCommand : '',
            buy: sample.purchaseCommand, claim: '/兑奖 领取 ' + samplePrize, details: '/兑奖 资料 ' + samplePrize + ' 0 '
        };
        const facts = { claimState, itemCount: condition === 'single' ? 1 : condition === 'empty' ? 0 : 2, buyAllowed: module === 'pool' && (root === 'settled' || root === 'probability' && condition !== 'empty') };
        const hiddenActions = Object.entries(layout.actionCommands(module, root, commands, scene, facts)).filter(([, value]) => !value).map(([key]) => key);
        const selectedRoot = mode === 'layout' ? key : root;
        const buttons = layout.buttonRows(module, config, selectedRoot, commands, scene, facts);

        if (mode === 'layout') { return { text: layout.finalizeMarkdown(config.replies[key]!, markers), root: key, buttons, hiddenActions }; }

        const error = outputError(module, config, common, root);

        if (error) { throw new Error(error.message); }

        const compose = (target: string, ancestors: string[] = [], overrides: Record<string, string> = {}): string => {
            if (ancestors.includes(target)) { throw new Error('模板片段循环'); }

            const field = fields[target]!, values: Record<string, string> = {}, data = { ...sample, ...overrides };

            for (const variable of field.variables) {
                if (['detail', 'actionResult'].includes(target) && variable === 'instructions' && ['terminal', 'expired'].includes(condition)
                    || target === 'item' && variable === 'claimAction' && (['claimed', 'terminal', 'expired'].includes(condition) || ['detail', 'actionResult'].includes(root))) {
                    values[variable] = '';
                    continue;
                }

                if (target === 'goodsWon' && variable === 'instructions') {
                    values[variable] = sample.instructions!;
                    continue;
                }

                const candidates = Object.entries(fields).filter(([, f]) => f.fragment?.message === target && f.fragment.variable === variable || f.fragment?.also?.some(use => use.message === target && use.variable === variable));
                let chosen = candidates.find(([, f]) => f.fragment?.when === condition) ?? candidates.find(([, f]) => !f.fragment?.when);

                if (candidates.some(([name]) => name === key) && ancestors.includes(root)) { chosen = candidates.find(([name]) => name === key); }

                if (variable === 'items' && chosen && !chosen[1].fragment?.when) {
                    let rows: Array<Record<string, string>>;

                    if (target === 'probability') {
                        rows = [
                            { label: '谢谢参与', icon: '🍀', reward: '0', probability: '35' },
                            { label: '小有收获', icon: '🪙', reward: '50', probability: '30' },
                            { label: '回本', icon: '🪙', reward: '100', probability: '20' },
                            { label: '虚拟礼物', icon: '🎁', reward: '0', rewardName: '纪念兑换券', probability: '10' },
                            { label: '特别大奖', icon: '📦', reward: '0', rewardName: '纪念奖品', probability: '5' }
                        ];
                    } else if (target === 'activities') {
                        rows = [
                            {}, { name: '第二个活动', purchaseCommand: '/抽奖 抽 demo2 2', purchaseUrl: commandUrl('/抽奖 抽 demo2 2', !group), probabilityUrl: commandUrl('/抽奖 奖项 demo2', !group) }
                        ];
                    } else {
                        const id = (module === 'prize' ? samplePrize : sampleDraw).slice(0, -1) + '7';
                        rows = condition === 'single' ? [{}] : [{}, {
                            id, name: '第二件奖品', continueUrl: commandUrl('/抽奖 继续 ' + id, !group), detailUrl: commandUrl('/兑奖 ' + id),
                            claimUrl: commandUrl('/兑奖 领取 ' + id), detailsUrl: commandUrl('/兑奖 资料 ' + id + ' 0 ', false)
                        }];
                    }

                    values[variable] = layout.joinItems(module, chosen[0], rows.map(row => compose(chosen![0], ancestors.concat(target), row)));
                    continue;
                }

                if (target === 'probabilityItem' && variable === 'reward' && data.rewardName) {
                    values[variable] = escapeMarkdown(data.rewardName);
                    continue;
                }

                values[variable] = chosen ? compose(chosen[0], ancestors.concat(target), overrides) : variable.endsWith('Url') ? data[variable]! : escapeMarkdown(data[variable] ?? (() => { throw new Error('缺少样例：' + variable); })());
            }

            const text = renderTemplate(config.replies[target]!, values);

            return target === key && key !== root ? markers.start + text + markers.end : text;
        };
        const text = layout.finalizeMarkdown(compose(root), markers);
        const outgoing = markers.start ? text.split(markers.start).join('').split(markers.end).join('') : text;

        if (!outgoing.replace(/\u200b/g, '').trim() || new TextEncoder().encode(outgoing).length > 16000) { throw new Error('消息展开后为空或超过16000字节'); }

        return { text, root, buttons, hiddenActions };
    }

    function scenarios(module: MessageModule, config: MessageConfiguration, key: string, common?: MessageConfiguration): Array<[string, string]> {
        const candidates: Array<[string, string]> = [...FIELDS[module][key]!.scenarios ?? [['normal', '默认']]];
        const seen = new Set<string>();

        if (module !== 'prize' && !FIELDS[module][key]!.fragment && !candidates.some(([value]) => value === 'group')) { candidates.push(['group', '群聊']); }

        if (module === 'prize' && key === 'list' && config.buttons.list?.flat().some(item => item.action === 'claim')) { candidates.push(['single', '仅一件待领取']); }

        return candidates.filter(([scenario]) => {
            const result = previewText(module, config, key, 'sample', scenario, { start: '', end: '' }, common);
            const signature = JSON.stringify([result.text, result.buttons]);

            if (seen.has(signature)) { return false; }

            seen.add(signature);

            return true;
        });
    }

    return Object.assign(previewText, { scenarios });
}

export const previewText = createTemplatePreview(FIELDS, { commandUrl, escapeMarkdown, renderTemplate, layout: createMessageLayout(FIELDS), defaultCommon: DEFAULTS.common, outputError });
