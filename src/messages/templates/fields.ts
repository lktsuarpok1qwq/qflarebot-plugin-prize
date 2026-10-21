export const MODULES = ['pool', 'prize', 'common'] as const;
export type MessageModule = typeof MODULES[number];
export interface TemplateField {
    title: string;
    group: string;
    text: string;
    variables: string[];
    required: string[];
    fragment?: { message: string; variable: string; when?: string; also?: Array<{ message: string; variable: string }> };
    actions?: string[];
}

const field = (title: string, group: string, text: string, variables: string[] = [], required: string[] = [],
    fragment?: TemplateField['fragment'], actions: string[] = []): TemplateField => ({ title, group, text, variables, required, fragment, actions });

function lottery(): Record<string, TemplateField> {
    return {
        help: field('使用帮助', '入口', '用法：{{command}} 抽 <奖池ID>、{{command}} 概率 <奖池ID>、{{command}} 记录 [奖池ID]', ['command']),
        activities: field('活动列表', '入口', '{{items}}', ['items']),
        activityItem: field('单个活动', '入口', '{{name}} · {{cost}} 积分\n{{purchaseCommand}}', ['name', 'cost', 'purchaseCommand'], [], { message: 'activities', variable: 'items' }),
        noActivities: field('暂无活动', '入口', '暂无开放活动', [], [], { message: 'activities', variable: 'items', when: 'empty' }),
        probability: field('当前概率', '概率', '{{name}} · {{state}}\n{{items}}\n查询时刻：{{time}}\n库存变化会影响实际概率', ['name', 'state', 'items', 'time']),
        probabilityItem: field('单个奖项概率', '概率', '{{label}}：{{probability}}%', ['label', 'probability'], [], { message: 'probability', variable: 'items' }),
        noCandidates: field('暂无有效奖项', '概率', '暂无有效奖项', [], [], { message: 'probability', variable: 'items', when: 'empty' }),
        pending: field('处理中', '购买结果', '业务{{state}}\n编号：{{id}}\n{{continueCommand}}', ['state', 'id', 'continueCommand'], ['continueCommand'], undefined, ['continue']),
        refunded: field('购买退款', '购买结果', '购买已取消，本金已退回\n业务编号：{{id}}', ['id']),
        settled: field('积分结果', '购买结果', '{{earnings}}\n本金：{{cost}} 积分\n净收益：{{net}} 积分\n编号：{{id}}', ['earnings', 'cost', 'net', 'id']),
        earned: field('积分中奖说明', '购买结果', '获得 {{reward}} 积分', ['reward'], [], { message: 'settled', variable: 'earnings' }),
        noWin: field('未中奖说明', '购买结果', '本次未中奖', [], [], { message: 'settled', variable: 'earnings', when: 'empty' }),
        goodsWon: field('商品中奖', '购买结果', '恭喜获得 {{name}}！\n请私聊机器人发送 {{prizeCommand}} 领取，或先查看兑奖记录。', ['name', 'prizeCommand'], ['prizeCommand']),
        records: field('本人业务记录', '记录', '{{items}}\n\n{{nextCommand}}', ['items', 'nextCommand'], ['nextCommand'], undefined, ['next']),
        recordItem: field('单笔业务记录', '记录', '{{id}} · {{state}} · 成本 {{cost}} · {{outcome}}', ['id', 'state', 'cost', 'outcome'], [], { message: 'records', variable: 'items' }),
        recordReward: field('记录积分说明', '记录', '奖励 {{reward}}', ['reward'], [], { message: 'recordItem', variable: 'outcome' }),
        recordPending: field('记录未完成说明', '记录', '处理中或已取消', [], [], { message: 'recordItem', variable: 'outcome', when: 'pending' }),
        recordGoods: field('记录商品中奖说明', '记录', '商品中奖', [], [], { message: 'recordItem', variable: 'outcome', when: 'goods' }),
        noRecords: field('暂无业务记录', '记录', '暂无记录', [], [], { message: 'records', variable: 'items', when: 'empty' })
    };
}

export const FIELDS: Record<MessageModule, Record<string, TemplateField>> = {
    pool: lottery(),
    prize: {
        help: field('使用帮助', '入口', '用法：{{prizeCommand}}、{{prizeCommand}} <编号>、{{prizeCommand}} 领取 [编号]、{{prizeCommand}} 资料 <编号> <资料版本> <资料>', ['prizeCommand']),
        list: field('兑奖与历史列表', '兑奖', '{{items}}\n\n{{nextCommand}}', ['items', 'nextCommand'], ['nextCommand'], undefined, ['next']),
        item: field('单件奖品', '兑奖', '{{id}} · {{name}} · {{state}}\n{{deadline}}', ['id', 'name', 'state', 'deadline'], [], { message: 'list', variable: 'items', also: [{ message: 'detail', variable: 'info' }, { message: 'actionResult', variable: 'info' }] }),
        deadline: field('申请期限', '兑奖', '申请截止（北京时间）：{{expires}}', ['expires'], [], { message: 'item', variable: 'deadline' }),
        empty: field('暂无兑奖记录', '兑奖', '暂无记录', [], [], { message: 'list', variable: 'items', when: 'empty' }),
        detail: field('奖品详情', '兑奖', '{{info}}\n资料版本：{{detailsVersion}}\n{{instructions}}', ['info', 'detailsVersion', 'instructions']),
        pendingInstructions: field('领取指引', '兑奖', '{{prizeCommand}} 领取 {{id}}', ['prizeCommand', 'id'], [], { message: 'detail', variable: 'instructions' }),
        claimedInstructions: field('交付资料指引', '兑奖', '{{prizeCommand}} 资料 {{id}} {{detailsVersion}} <最少必要交付资料>', ['prizeCommand', 'id', 'detailsVersion'], [], { message: 'detail', variable: 'instructions', when: 'claimed' }),
        actionResult: field('申请与资料回执', '兑奖', '{{action}}\n{{info}}\n当前资料版本：{{detailsVersion}}', ['action', 'info', 'detailsVersion'])
    },
    common: {
        error: field('业务错误', '通用提示', '{{message}}', ['message', 'code']),
        accountRequired: field('开户指引', '通用提示', '请本人私聊机器人发送 {{pointsCommand}} 开户', ['pointsCommand'], ['pointsCommand']),
        privateOnly: field('私聊指引', '通用提示', '请私聊机器人发送 {{prizeCommand}}', ['prizeCommand'], ['prizeCommand'])
    }
};

export const WORDS: Record<string, { title: string; text: string }> = Object.fromEntries(Object.entries({
    INSUFFICIENT_BALANCE: '积分不足', ACCOUNT_SUSPENDED: '积分账户已暂停', ADMISSION_CLOSED: '暂未开放新抽奖', POOL_CLOSED: '活动未开放',
    ADMISSION_LIMIT: '名额不足或业务繁忙，请稍后发送新命令', EVENT_ID_REQUIRED: '缺少可信消息标识，无法执行',
    POINTS_NOT_READY: '积分服务尚未就绪', SOURCE_DISABLED: '积分来源已停用', SOURCE_NOT_ALLOWED: '积分来源权限不足', SOURCE_NOT_REGISTERED: '积分来源尚未登记',
    CLAIM_STATE: '此奖品当前不能执行该操作', SPECIFY_PRIZE: '符合条件的奖品不止一件，请指定编号', NO_ELIGIBLE_PRIZE: '没有符合条件的奖品',
    DETAILS_VERSION_CONFLICT: '资料版本已过期，请重新查看奖品详情', CURSOR_EXPIRED: '列表已变化，请重新查询', CURSOR_INVALID: '翻页标识无效，请重新查询',
    CONFLICT: '记录已变化，请查看后发送新命令', SCHEMA_NOT_READY: '奖品中心正在自动准备', SCHEMA_INITIALIZING: '奖品中心正在自动准备，请稍后重试',
    SCHEMA_UNSUPPORTED: '奖品中心数据结构需要核查', NOT_FOUND: '未找到本人的记录', ARCHIVE_DISABLED: '历史归档未开启', QUERY_WORK_LIMIT: '查询范围过大，请缩小范围',
    UNAVAILABLE: '暂时无法完成，请稍后查看原业务记录', processing: '处理中', review: '等待管理员核查',
    actionClaim: '原领取申请已记录', actionDetails: '原资料提交已记录',
    draw_CREATED: '处理中', draw_DEBITED: '已扣款', draw_DRAWN: '结果已固定', draw_SETTLING: '发奖中', draw_CANCELLING: '退款处理中',
    draw_SETTLED: '已完成', draw_FAILED: '未购买', draw_REFUNDED: '已退款', draw_NEEDS_REVIEW: '待核查',
    claim_LOCKED: '处理中', claim_PENDING: '待申请', claim_CLAIMED: '待发放', claim_FULFILLED: '已发放', claim_EXPIRED: '已过期', claim_CANCELLED: '已取消',
    pool_DRAFT: '草稿', pool_ACTIVE: '开放中', pool_PAUSED: '已暂停', pool_CLOSED: '已关闭', pool_ARCHIVED: '已归档'
}).map(([key, text]) => [key, { title: (key.startsWith('draw_') ? '抽奖状态 · ' : key.startsWith('claim_') ? '兑奖状态 · ' : key.startsWith('pool_') ? '活动状态 · ' : '提示 · ') + text, text }]));

export const VARIABLE_HELP: Record<string, string> = {
    command: '本次命中的模块命令，包含实际前缀', prizeCommand: '本人私聊兑奖命令，包含实际前缀', pointsCommand: '积分命令，包含实际前缀',
    name: '当前活动或中奖奖项名称', cost: '整笔费用或活动单价，单位积分，保留两位小数', reward: '积分奖励，保留两位小数',
    net: '奖励减费用的净收益，可为负数', id: '本人业务或奖品编号', state: '当前状态的自定义用语',
    label: '公开奖项标签，不含内部商品名称', probability: '当前有效百分比，不含百分号', time: '概率查询时刻', expires: '原申请截止时间，北京时间',
    detailsVersion: '当前交付资料版本，提交更正时原样携带', continueCommand: '原业务继续命令，只处理本次业务', purchaseCommand: '该活动的购买命令',
    nextCommand: '原列表下一页命令；没有后续页时为空', message: '按错误类型配置的说明', code: '稳定错误代码', action: '本次操作的自定义回执用语',
    items: '按当前片段草稿组成的列表', earnings: '按中奖或未中奖草稿生成的说明', outcome: '按原业务结果生成的说明',
    deadline: '原申请期限片段；未取得奖品时为空', info: '当前场景允许展示的奖品片段', instructions: '按当前兑奖状态选择的指引片段'
};
