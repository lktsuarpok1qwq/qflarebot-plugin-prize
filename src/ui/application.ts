import { money } from '../lottery/rules.js';
import { runtime } from './runtime.js';
import { editor } from './pools/editor.js';
import { catalogUI } from './pools/catalog.js';
import { stockUI } from './stock.js';
import { settingsUI } from './settings.js';
import { recordsUI } from './records/render.js';
import { datesUI } from './records/dates.js';
import { listUI } from './records/list.js';
import { claimsUI } from './claims.js';
import { recordQueryUI } from './records/query.js';
import { statisticsUI } from './statistics.js';
import { advancedUI } from './records/advanced.js';
import { navigationUI } from './navigation.js';
import { messagesUI } from './messages/editor.js';

// 只在管理 HTML 请求时组装静态脚本；初始化仅绑定页面，不读取业务数据。
export function applicationUI(): string {
    return [
        "import { createBridge } from '/bridge.js';",
        runtime, editor, catalogUI, stockUI, settingsUI, recordsUI, datesUI, listUI, claimsUI,
        recordQueryUI, statisticsUI, advancedUI, navigationUI, messagesUI(),
        'const formatMoney = ' + money.toString() + ';',
        String.raw`
const bridge = await createBridge();
let settings, rules, catalog, stock, messages;
const core = initRuntime({ bridge, syncDirty: () => settings.syncDirty(), validateRequest: (...args) => rules.validateRequest(...args) });
settings = initSettings({ ...core, syncMessages: () => messages.sync(), syncRules: () => rules.ruleEditors.forEach(editor => editor.syncDirty()), syncStockControls: () => stock.syncStockControls() });
rules = initRules({ ...core, configurationError: (...args) => messages.configurationError(...args), loadCatalog: (...args) => stock.loadCatalog(...args), updateActivity: pool => catalog.updateActivity(pool) });
catalog = initCatalog({ ...core, formatMoney, poolEditor: rules.poolEditor });
stock = initStock({ ...core, activityRequest: catalog.activityRequest, refreshProducts: () => rules.ruleEditors.forEach(editor => editor.refreshProducts()) });
messages = initMessages(core);
const dates = initDates(core);
const records = initRecordView(core);
const claims = initClaims({ ...core, ...records });
const lists = initLists({ ...core, ...dates, ...records, ...claims, fields: rules.fields });
lists.setupList('claimSearch', 'claimList', 'claimNext', 'claims');
lists.setupList('recordSearch', 'recordList', 'recordNext', 'draws');
initRecordQuery({ ...core, ...records });
initStatistics({ ...core, ...dates, ...records });
initAdvanced({ ...core, ...records });
initNavigation({ ...core, messageEditor: messages, showStockList: stock.showStockList, poolEditor: rules.poolEditor, syncDirty: settings.syncDirty });
`
    ].join('\n');
}
