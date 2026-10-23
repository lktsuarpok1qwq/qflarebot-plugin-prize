export const messageComposition = String.raw`
function createMessageComposition({ FIELDS, ICONS, messageLayout, awardIcon, navigation, current, edit, changed, $, node, createTextTools }) {
    function separatorKeys(model = current()) {
        return Object.keys(FIELDS[model.module]).filter(key => {
            const fragment = FIELDS[model.module][key].fragment;

            return fragment?.separator !== undefined && navigation.parent(model.module, model.command, key) === fragment.message && (key === model.key || fragment.message === model.key);
        });
    }

    function setSeparator(key, value, model = current()) {
        if (value === FIELDS[model.module][key].fragment.separator) {
            if (model.draft.separators) {
                delete model.draft.separators[key];

                if (!Object.keys(model.draft.separators).length) { delete model.draft.separators; }
            }
        } else { (model.draft.separators ||= {})[key] = value; }
    }

    function related() {
        const fields = FIELDS[current().module], key = current().key;
        $('reply-related').replaceChildren();
        const root = navigation.context(current().module, current().command, key).root;

        const targets = root === key ? [] : [[root, '编辑完整消息']];

        const available = new Set(navigation.entries(current().module, current().command).map(item => item.key));

        for (const [child, field] of Object.entries(fields)) {
            if (!available.has(child)) { continue; }

            if ([field.fragment, ...(field.fragment?.also || [])].some(use => use?.message === key && current().draft.replies[key].includes('{{' + use.variable + '}}'))) {
                targets.push([child, '编辑' + field.title]);
            }
        }

        for (const [target, label] of targets) {
            const b = node('button', label, 'qb-btn');
            b.type = 'button';
            b.onclick = () => {
                edit(target);
                $('reply-body').focus({ preventScroll: true });
            };
            $('reply-related').append(b);
        }

        $('reply-related').hidden = !$('reply-related').children.length;
    }

    function composition() {
        const fields = FIELDS[current().module];
        related();
        icons();
        const keys = separatorKeys();
        $('reply-separators').hidden = !keys.length;
        $('reply-separator-fields').replaceChildren();

        for (const key of keys) {
            const label = node('label', fields[key].title + ' · 项目间隔'), input = node('textarea', undefined, 'qb-input qb-mono');
            input.rows = 3;
            input.dataset.separator = key;
            input.id = 'reply-separator-' + key;
            input.spellcheck = false;
            input.value = messageLayout.separatorFor(current().module, current().draft, key);
            const count = node('p', undefined, 'hint');
            count.id = input.id + '-hint';
            input.setAttribute('aria-describedby', count.id);
            const update = () => {
                setSeparator(key, input.value);
                count.textContent = '当前包含 ' + (input.value.match(/\n/g) || []).length + ' 个换行';
                changed();
            };
            const tools = createTextTools(input, update), toolbar = node('div', undefined, 'actions');
            tools.retainSelection(toolbar);

            for (const [name, text] of [['换行', '\n'], ['分隔线', '\n***\n']]) {
                const b = node('button', name, 'qb-btn');
                b.type = 'button';
                b.onclick = () => tools.insert(text, '', '', true);
                toolbar.append(b);
            }

            input.oninput = update;
            count.textContent = '当前包含 ' + (input.value.match(/\n/g) || []).length + ' 个换行';
            label.append(input);
            $('reply-separator-fields').append(label, toolbar, count);
            const position = current().positions.get(current().command + '/' + current().key)?.separators?.[key];

            if (position) {
                input.setSelectionRange(Math.min(position.start, input.value.length), Math.min(position.end, input.value.length));
                input.scrollTop = position.top;
            }
        }
    }

    function iconKeys(model = current()) {
        const fields = FIELDS[model.module];

        return model.module === 'pool' && (fields[model.key].variables.includes('icon') || model.key === 'probability');
    }

    function icons() {
        $('reply-icons').hidden = !iconKeys();
        $('reply-icon-fields').replaceChildren();

        if (!iconKeys()) { return; }

        for (const [type, info] of Object.entries(ICONS)) {
            const label = node('label', info.title), input = node('input', undefined, 'qb-input');
            input.dataset.icon = type;
            input.id = 'reply-icon-' + type;
            input.setAttribute('aria-describedby', 'reply-icons-hint');
            input.value = awardIcon(current().draft, type);
            input.oninput = () => {
                if (input.value === info.text) {
                    delete current().draft.icons?.[type];

                    if (!Object.keys(current().draft.icons || {}).length) { delete current().draft.icons; }
                } else { (current().draft.icons ||= {})[type] = input.value; }

                changed();
            };
            label.append(input);
            $('reply-icon-fields').append(label);
        }
    }

    return { render: composition, related, separatorKeys, setSeparator, iconKeys };
}
`;
