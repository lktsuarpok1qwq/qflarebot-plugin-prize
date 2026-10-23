import { FIELDS } from './fields.js';
import type { MessageModule } from './fields.js';
import { editorNavigation } from './navigation.js';
import { DEFAULTS, awardIcon, commandUrl, escapeMarkdown, renderTemplate } from './config.js';
import type { MessageConfiguration } from './config.js';
import { createMessageLayout } from './layout.js';
import type { MessageCommands, PreviewMarkers, RenderedButton } from './layout.js';
import { outputError } from './budget.js';

// 固定样例只用于浏览器预览，不读账户、不取随机结果。
export function createTemplatePreview(fields: typeof FIELDS, helpers: {
    escapeMarkdown: typeof escapeMarkdown; renderTemplate: typeof renderTemplate; commandUrl: typeof commandUrl;
    layout: ReturnType<typeof createMessageLayout>; defaultCommon: MessageConfiguration; outputError: typeof outputError; awardIcon: typeof awardIcon; navigation: typeof editorNavigation;
}) {
    const FIELDS = fields, { commandUrl, escapeMarkdown, renderTemplate, layout, defaultCommon, outputError, awardIcon, navigation } = helpers;

    function renderPreview(module: MessageModule, config: MessageConfiguration, key: string, mode: string, scenario: string,
        markers: PreviewMarkers, common: MessageConfiguration = module === 'common' ? config : defaultCommon, command?: string, deliveryScene: 'c2c' | 'group' = 'c2c', budgetChecked = false, validationOnly = false): {
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

        const context = command ? navigation.context(module, command, key) : undefined;

        if (context) { root = context.root; }

        const selected = scenario;
        const condition = selected === 'normal' ? (context ? undefined : fields[key]!.fragment?.when) ?? '' : selected;
        const scene = module === 'common' && root === 'privateOnly' ? 'group' : deliveryScene;
        const group = scene === 'group';
        const claimState = condition === 'terminal' ? 'FULFILLED' : condition === 'cancelled' ? 'CANCELLED' : 'PENDING';
        const word = (key: string) => {
            if (common.words[key] === undefined) { throw new Error('缺少通用用语：' + key); }

            return common.words[key]!;
        };
        const sampleDraw = 'D4845cd5fd64d48b4801f13a7c4959536', samplePrize = 'P4845cd5fd64d48b4801f13a7c4959536';
        const next = !['empty', 'last'].includes(condition);
        const sample: Record<string, string> = {
            purchaseUrl: commandUrl('/抽奖 抽 demo', !group), probabilityUrl: commandUrl('/抽奖 奖项 demo', !group),
            prizeUrl: commandUrl('/兑奖', !group),
            command: '/抽奖', prizeCommand: '/兑奖', pointsCommand: '/积分', name: '示例活动', cost: '1', reward: '5', net: '4',
            id: sampleDraw, state: word('draw_SETTLED'), label: '积分奖', icon: awardIcon(config, 'POINTS'), probability: '25', time: '2026-10-01T12:00:00Z',
            purchaseCommand: '/抽奖 抽 demo', nextCommand: next ? '/抽奖 记录 ~示例游标' : '',
            message: word('INSUFFICIENT_BALANCE'), code: 'INSUFFICIENT_BALANCE', instructions: ''
        };

        if (root === 'activities') { sample.nextCommand = next ? '/抽奖 ~示例游标' : ''; }

        if (module === 'prize') {
            sample.name = '示例奖品';
            sample.id = samplePrize;
            sample.nextCommand = next ? '/兑奖 ~示例游标' : '';
            sample.time = '2026-10-01 20:00:00';
        }

        if (module === 'pool' && root === 'probability') { sample.state = word('pool_ACTIVE'); }

        if (module === 'pool' && (root === 'pending' || condition === 'pending')) { sample.state = word(condition === 'review' ? 'review' : 'processing'); }

        if (module === 'prize' || root === 'goodsWon') { sample.state = word('claim_' + claimState); }

        if (module === 'pool' && condition === 'goods') { sample.name = '示例奖品'; }

        if (root === 'goodsWon') {
            sample.name = '示例奖品';
        }

        const commands: MessageCommands = {
            pool: '/抽奖', records: '/抽奖 记录', prizes: '/兑奖', account: '/积分 开户',
            next: sample.nextCommand,
            buy: sample.purchaseCommand
        };
        const facts = { buyAllowed: module === 'pool' && (root === 'settled' || root === 'probability' && condition !== 'closed' && condition !== 'empty') };
        const hiddenActions = validationOnly ? [] : Object.entries(layout.actionCommands(commands, facts)).filter(([, value]) => !value).map(([key]) => key);
        const selectedRoot = mode === 'layout' ? key : root;
        const buttons = layout.buttonRows(module, config, selectedRoot, commands, scene, facts);

        if (mode === 'layout') { return { text: layout.finalizeMarkdown(config.replies[key]!, markers), root: key, buttons, hiddenActions }; }

        const error = budgetChecked ? null : outputError(module, config, common, root);

        if (error) { throw new Error(error.message); }

        const compose = (target: string, ancestors: string[] = [], overrides: Record<string, string> = {}): string => {
            if (ancestors.includes(target)) { throw new Error('模板片段循环'); }

            const field = fields[target]!, values: Record<string, string> = {}, data = { ...sample, ...overrides };

            for (const variable of field.variables) {
                const candidates = layout.fragmentCandidates(module, target, variable);
                let chosen = candidates.find(([, f]) => f.fragment?.when === condition) ?? candidates.find(([, f]) => !f.fragment?.when);

                if (!context && candidates.some(([name]) => name === key) && ancestors.includes(root)) { chosen = candidates.find(([name]) => name === key); }

                if (variable === 'items' && chosen && !chosen[1].fragment?.when) {
                    let rows: Array<Record<string, string>>;

                    if (target === 'probability') {
                        rows = [
                            { label: '谢谢参与', icon: awardIcon(config, 'NONE'), reward: '0', probability: '35' },
                            { label: '小有收获', icon: awardIcon(config, 'POINTS'), reward: '50', probability: '30' },
                            { label: '回本', icon: awardIcon(config, 'POINTS'), reward: '100', probability: '20' },
                            { label: '虚拟礼物', icon: awardIcon(config, 'VIRTUAL_MANUAL'), reward: '0', rewardName: '纪念兑换券', probability: '10' },
                            { label: '特别大奖', icon: awardIcon(config, 'PHYSICAL'), reward: '0', rewardName: '纪念奖品', probability: '5' }
                        ];
                    } else if (target === 'activities') {
                        rows = [
                            {}, { name: '第二个活动', purchaseCommand: '/抽奖 抽 demo2', purchaseUrl: commandUrl('/抽奖 抽 demo2', !group), probabilityUrl: commandUrl('/抽奖 奖项 demo2', !group) }
                        ];
                    } else {
                        const id = (module === 'prize' ? samplePrize : sampleDraw).slice(0, -1) + '7';
                        rows = [{}, { id, name: '第二件奖品' }];
                    }

                    values[variable] = layout.joinItems(module, config, chosen[0], rows.map(row => compose(chosen![0], ancestors.concat(target), row)));
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

    function previewText(module: MessageModule, config: MessageConfiguration, key: string, mode: string, scenario: string,
        markers: PreviewMarkers, common: MessageConfiguration = module === 'common' ? config : defaultCommon, command?: string, deliveryScene: 'c2c' | 'group' = 'c2c') {
        return renderPreview(module, config, key, mode, scenario, markers, common, command, deliveryScene);
    }

    function scenarios(module: MessageModule, config: MessageConfiguration, key: string, common?: MessageConfiguration, command?: string, budgetChecked = false): Array<[string, string]> {
        const context = command ? navigation.context(module, command, key) : undefined;
        const root = context?.root ?? key;
        const error = budgetChecked ? null : outputError(module, config, common ?? (module === 'common' ? config : defaultCommon), root);

        if (error) { throw new Error(error.message); }

        let candidates: Array<[string, string]> = [...FIELDS[module][root]!.scenarios ?? [['normal', '默认']]];
        const seen = new Set<string>();

        if (context) {
            if (module === 'pool' && root === 'records') { candidates.push(['pending', '处理中'], ['goods', '商品中奖']); }

            if (module === 'prize' && root === 'list') {
                candidates = [...candidates, ['terminal', '已发放'], ['cancelled', '已撤销']];
            }
        }

        return candidates.filter(([scenario]) => {
            const markers = context && FIELDS[module][key]!.fragment ? { start: '\uE000S', end: '\uE000E' } : { start: '', end: '' };
            const result = renderPreview(module, config, key, 'sample', scenario, markers, common, command, 'c2c', true);

            if (markers.start && !result.text.includes(markers.start)) { return false; }

            const signature = JSON.stringify([result.text, result.buttons]);

            if (seen.has(signature)) { return false; }

            seen.add(signature);

            return true;
        });
    }

    // 完整校验逐一展开所有声明情景，不计算编辑器选项去重和隐藏动作说明。
    function validate(module: MessageModule, config: MessageConfiguration, key: string, common: MessageConfiguration): void {
        for (const [scenario] of FIELDS[module][key]!.scenarios ?? [['normal', '默认']]) {
            renderPreview(module, config, key, 'sample', scenario, { start: '', end: '' }, common, undefined, 'c2c', true, true);
        }
    }

    return Object.assign(previewText, { scenarios, validate });
}

export const previewText = createTemplatePreview(FIELDS, { commandUrl, escapeMarkdown, renderTemplate, layout: createMessageLayout(FIELDS), defaultCommon: DEFAULTS.common, outputError, awardIcon, navigation: editorNavigation });
