export const MODULES = ['pool', 'prize', 'common'] as const;
export type MessageModule = typeof MODULES[number];
export interface TemplateField {
    title: string;
    group: string;
    text: string;
    variables: string[];
    required: string[];
    fragment?: { message: string; variable: string; when?: string; separator?: string; also?: Array<{ message: string; variable: string }> };
    actions?: string[];
    requiredActions?: string[];
    defaultActions?: string[];
    scenarios?: Array<[string, string]>;
}

const field = (title: string, group: string, text: string, variables: string[] = [], required: string[] = [],
    fragment?: TemplateField['fragment'], actions: string[] = []): TemplateField => ({ title, group, text, variables, required, fragment, actions, requiredActions: actions });

function lottery(): Record<string, TemplateField> {
    return {
        help: field('使用帮助', '入口', '🎟️ **奖池抽奖**\n\n选择奖池后购买，自动扣款并开奖\n\n⌨️ {{command}} 抽 <奖池ID>', ['command']),
        activities: field('活动列表', '入口', '🎰 **奖池列表**\n\n{{notice}}{{items}}', ['items', 'notice', 'nextCommand']),
        activityItem: field('单个活动', '入口', '🎟️ **{{name}}**\n\n💰 每次 {{cost}} 积分\n\n[🛒 购买]({{purchaseUrl}})　[🏆 奖项]({{probabilityUrl}})', ['name', 'cost', 'purchaseCommand', 'purchaseUrl', 'probabilityUrl'], [], { message: 'activities', variable: 'items', separator: '\n\n***\n\n' }),
        noActivities: field('暂无活动', '入口', '🌙 暂无开放活动', [], [], { message: 'activities', variable: 'items', when: 'empty' }),
        probability: field('奖项一览', '奖项一览', '🏆 **{{name}} · 奖项一览**\n\n💰 每次 {{cost}} 积分\n\n{{items}}\n\nℹ️ 库存变化会影响概率', ['name', 'cost', 'state', 'items', 'time']),
        probabilityItem: field('单个奖项', '奖项一览', '{{icon}} **{{label}}**\n\n🎁 奖励：{{reward}}\n\n🎲 概率：{{probability}}%', ['label', 'probability', 'reward', 'icon'], [], { message: 'probability', variable: 'items', separator: '\n\n***\n\n' }),
        noCandidates: field('暂无有效奖项', '奖项一览', '🌙 暂无有效奖项', [], [], { message: 'probability', variable: 'items', when: 'empty' }),
        pending: field('处理中', '购买结果', '⏳ **{{state}}**\n\n本笔购买已记录，请勿重复购买\n\n🔎 [结果]({{continueUrl}})\n\n🧾 {{id}}', ['state', 'id', 'continueCommand', 'continueUrl'], [], undefined, ['continue']),
        refunded: field('购买退款', '购买结果', '↩️ **购买已取消，积分已退回**\n\n🧾 {{id}}', ['id']),
        settled: field('积分结果', '购买结果', '{{earnings}}', ['earnings', 'cost', 'net', 'id']),
        earned: field('积分中奖说明', '购买结果', '获得 {{reward}} 积分', ['reward'], [], { message: 'settled', variable: 'earnings' }),
        noWin: field('零奖励说明', '购买结果', '获得 0 积分', [], [], { message: 'settled', variable: 'earnings', when: 'empty' }),
        goodsWon: field('商品中奖', '购买结果', '获得 {{name}}', ['name', 'prizeCommand', 'state', 'instructions'], []),
        records: field('本人业务记录', '记录', '📜 **抽奖记录**\n\n{{items}}', ['items', 'nextCommand'], [], undefined, ['next']),
        recordItem: field('单笔业务记录', '记录', '📌 {{state}}\n\n💰 花费 {{cost}} 积分 · {{outcome}}\n🔎 [结果]({{continueUrl}})\n🧾 {{id}}', ['id', 'state', 'cost', 'outcome', 'continueUrl'], [], { message: 'records', variable: 'items', separator: '\n\n' }),
        recordReward: field('积分奖励说明', '奖项一览', '{{reward}} 积分', ['reward'], [], { message: 'probabilityItem', variable: 'reward', also: [{ message: 'recordItem', variable: 'outcome' }] }),
        recordPending: field('记录未完成说明', '记录', '处理中或已取消', [], [], { message: 'recordItem', variable: 'outcome', when: 'pending' }),
        recordGoods: field('记录商品中奖说明', '记录', '商品中奖', [], [], { message: 'recordItem', variable: 'outcome', when: 'goods' }),
        noRecords: field('暂无业务记录', '记录', '暂无记录', [], [], { message: 'records', variable: 'items', when: 'empty' })
    };
}

export const FIELDS: Record<MessageModule, Record<string, TemplateField>> = {
    pool: lottery(),
    prize: {
        help: field('使用帮助', '入口', '🎁 **我的奖品**\n\n在对应奖品下领取，按需补充交付资料\n\n⌨️ {{prizeCommand}}', ['prizeCommand']),
        list: field('兑奖与历史列表', '兑奖', '🎁 **奖品记录**\n\n{{items}}', ['items', 'nextCommand'], [], undefined, ['next']),
        item: field('单件奖品', '兑奖', '🎁 **{{name}}**\n\n📌 {{state}}\n{{deadline}}\n\n🔎 [详情]({{detailUrl}})　{{claimAction}}\n🧾 {{id}}', ['id', 'name', 'state', 'deadline', 'detailUrl', 'claimAction'], [], { message: 'list', variable: 'items', separator: '\n\n', also: [{ message: 'detail', variable: 'info' }, { message: 'actionResult', variable: 'info' }] }),
        deadline: field('申请期限', '兑奖', '⏰ 领取截止：{{expires}}（北京时间）', ['expires'], [], { message: 'item', variable: 'deadline' }),
        empty: field('暂无兑奖记录', '兑奖', '暂无记录', [], [], { message: 'list', variable: 'items', when: 'empty' }),
        detail: field('奖品详情', '兑奖', '{{info}}\n\n{{instructions}}', ['info', 'detailsVersion', 'instructions']),
        pendingInstructions: field('领取指引', '兑奖', '[🎁 领取]({{claimUrl}})', ['prizeCommand', 'id', 'claimUrl'], [], { message: 'detail', variable: 'instructions', also: [{ message: 'item', variable: 'claimAction' }] }),
        claimedInstructions: field('交付资料指引', '兑奖', '📦 等待发放\n\n📝 [资料]({{detailsUrl}})，补充后发送', ['prizeCommand', 'id', 'detailsVersion', 'detailsUrl'], [], { message: 'detail', variable: 'instructions', when: 'claimed', also: [{ message: 'actionResult', variable: 'instructions' }] }),
        actionResult: field('申请与资料回执', '兑奖', '✅ **{{action}}**\n\n{{info}}\n\n{{instructions}}', ['action', 'info', 'detailsVersion', 'instructions'])
    },
    common: {
        error: field('业务错误', '通用提示', '⚠️ {{message}}', ['message', 'code']),
        accountRequired: field('开户指引', '通用提示', '👤 请本人私聊机器人开户\n\n⌨️ {{pointsCommand}} 开户', ['pointsCommand'], ['pointsCommand']),
        privateOnly: field('私聊指引', '通用提示', '👤 请私聊机器人操作\n\n⌨️ {{prizeCommand}}', ['prizeCommand'], ['prizeCommand'])
    }
};

export const ACTION_LABELS: Record<string, string> = { continue: '🔎 结果', next: '下一页', pool: '🎰 奖池', records: '📜 记录', prizes: '🎁 奖品', history: '历史', buy: '🛒 购买', claim: '领取', details: '📝 资料', account: '开户' };

const actions: Partial<Record<MessageModule, Record<string, string[]>>> = {
    pool: { help: ['pool', 'records', 'prizes'], activities: ['next', 'pool', 'records', 'prizes'], probability: ['buy', 'pool', 'records'], refunded: ['pool', 'records'], settled: ['buy', 'pool', 'records', 'prizes'], goodsWon: ['claim', 'details', 'prizes', 'pool'], records: ['pool', 'prizes'] },
    prize: { help: ['prizes', 'history', 'pool'], list: ['claim', 'history', 'pool'], detail: ['claim', 'details', 'prizes'], actionResult: ['details', 'prizes', 'pool'] },
    common: { error: ['pool', 'records', 'prizes'], accountRequired: ['account'], privateOnly: ['prizes'] }
};

for (const module of MODULES) {
    for (const [key, values] of Object.entries(actions[module] ?? {})) { FIELDS[module][key]!.actions = [...FIELDS[module][key]!.actions ?? [], ...values]; }
}

FIELDS.pool.activities!.scenarios = [['normal', '有奖池'], ['empty', '无奖池'], ['last', '末页']];
FIELDS.pool.probability!.scenarios = [['normal', '有奖项'], ['empty', '无有效奖项']];
FIELDS.pool.pending!.scenarios = [['normal', '处理中'], ['review', '待核查']];
FIELDS.pool.settled!.scenarios = [['normal', '积分中奖'], ['empty', '零奖励']];
FIELDS.pool.goodsWon!.scenarios = [['normal', '待领取'], ['claimed', '待发放'], ['expired', '已过期'], ['terminal', '已结束'], ['group', '群聊指引']];
FIELDS.pool.records!.scenarios = [['normal', '有记录'], ['empty', '无记录'], ['last', '末页']];
FIELDS.pool.recordItem!.scenarios = [['normal', '积分结果'], ['pending', '处理中'], ['goods', '商品中奖']];
FIELDS.prize.list!.scenarios = [['normal', '有奖品'], ['empty', '无记录'], ['last', '末页']];
FIELDS.prize.item!.scenarios = [['normal', '待领取'], ['claimed', '待发放'], ['expired', '已过期'], ['terminal', '已结束']];
FIELDS.prize.detail!.scenarios = FIELDS.prize.item!.scenarios;
FIELDS.prize.actionResult!.scenarios = [['normal', '待发放'], ['terminal', '已结束']];

FIELDS.prize.list!.defaultActions = ['next', 'history', 'pool'];
FIELDS.common.privateOnly!.defaultActions = [];

export const WORDS: Record<string, { title: string; text: string }> = Object.fromEntries(Object.entries({
    INSUFFICIENT_BALANCE: '积分不足，请先获取积分', ACCOUNT_SUSPENDED: '积分账户已暂停', ADMISSION_CLOSED: '暂未开放新抽奖', POOL_CLOSED: '活动未开放',
    ADMISSION_LIMIT: '名额不足或业务繁忙，请稍后发送新命令', EVENT_ID_REQUIRED: '缺少可信消息标识，无法执行',
    POINTS_NOT_READY: '积分服务尚未就绪', SOURCE_DISABLED: '积分来源已停用', SOURCE_NOT_ALLOWED: '积分来源权限不足', SOURCE_NOT_REGISTERED: '积分来源尚未登记',
    CLAIM_STATE: '此奖品当前不能执行该操作', SPECIFY_PRIZE: '有多件待领奖品，请打开我的奖品选择领取', NO_ELIGIBLE_PRIZE: '没有符合条件的奖品',
    DETAILS_VERSION_CONFLICT: '资料版本已过期，请重新查看奖品详情', CURSOR_EXPIRED: '列表已变化，请重新查询', CURSOR_INVALID: '翻页标识无效，请重新查询',
    CONFLICT: '信息已更新，请重新选择', SCHEMA_NOT_READY: '奖品中心正在自动准备', SCHEMA_INITIALIZING: '奖品中心正在自动准备，请稍后重试',
    SCHEMA_UNSUPPORTED: '奖品中心数据结构需要核查', NOT_FOUND: '未找到本人的记录', ARCHIVE_DISABLED: '历史归档未开启', QUERY_WORK_LIMIT: '查询范围过大，请缩小范围',
    UNAVAILABLE: '暂时无法完成，请稍后查看原业务记录', processing: '处理中', review: '等待管理员核查',
    actionClaim: '领取申请已记录', actionDetails: '交付资料已记录',
    draw_CREATED: '处理中', draw_DEBITED: '已扣款', draw_DRAWN: '结果已固定', draw_SETTLING: '发奖中', draw_CANCELLING: '退款处理中',
    draw_SETTLED: '已完成', draw_FAILED: '未购买', draw_REFUNDED: '已退款', draw_NEEDS_REVIEW: '待核查',
    claim_LOCKED: '处理中', claim_PENDING: '待领取', claim_CLAIMED: '待发放', claim_FULFILLED: '已发放', claim_EXPIRED: '已过期', claim_CANCELLED: '已取消',
    pool_DRAFT: '草稿', pool_ACTIVE: '开放中', pool_PAUSED: '已暂停', pool_CLOSED: '已关闭', pool_ARCHIVED: '已归档'
}).map(([key, text]) => [key, { title: (key.startsWith('draw_') ? '抽奖状态 · ' : key.startsWith('claim_') ? '兑奖状态 · ' : key.startsWith('pool_') ? '活动状态 · ' : '提示 · ') + text, text }]));

export const VARIABLE_HELP: Record<string, string> = {
    purchaseUrl: '该奖池的购买命令链接，包含实际前缀', probabilityUrl: '该奖池的奖项一览命令链接', continueUrl: '原购买结果链接', detailUrl: '本人奖品详情链接', claimUrl: '该奖品的申请链接', detailsUrl: '带原奖品编号和当前版本的资料填写链接，仅填入输入框',
    command: '本次命中的模块命令，包含实际前缀', prizeCommand: '本人私聊兑奖命令，包含实际前缀', pointsCommand: '积分命令，包含实际前缀',
    name: '当前活动或中奖奖项名称', cost: '整笔费用或活动单价，单位积分，最多两位小数且省略尾零', reward: '积分奖励数值；单个奖项中为奖励说明（积分或奖品名称）',
    net: '奖励减费用的净收益，可为负数，省略小数尾零', id: '本人业务或奖品编号', state: '当前状态的自定义用语',
    icon: '奖项类型图标：未中奖、积分、虚拟奖品或其他', label: '公开奖项标签，奖品名称单独显示，不填写交付秘密', probability: '当前有效百分比，不含百分号；省略小数末尾的0', time: '概率查询时刻', expires: '原申请截止时间，北京时间',
    detailsVersion: '当前交付资料版本，提交更正时原样携带', continueCommand: '原业务继续命令，只处理本次业务', purchaseCommand: '该活动的购买命令',
    nextCommand: '原列表下一页命令；没有后续页时为空', message: '按错误类型配置的说明', code: '稳定错误代码', action: '本次操作的自定义回执用语',
    notice: '报价变化等需要展示的提示；正常列表为空', claimAction: '该件奖品的领取链接；不可领取时为空', items: '按当前片段草稿组成的列表', earnings: '按中奖或未中奖草稿生成的说明', outcome: '按原业务结果生成的说明',
    deadline: '原申请期限片段；未取得奖品时为空', info: '当前场景允许展示的奖品片段', instructions: '按当前兑奖状态选择的指引片段'
};
