export const messageButtons = String.raw`
function createMessageButtons(current, changed) {
    let controls = [];
    const actions = { command: '自定义命令', link: '打开链接', continue: '原业务继续', next: '原列表翻页' };
    const make = (tag, value, cls) => node(tag, value, cls);
    const field = (name, input) => {
        const label = make('label', name);
        input.setAttribute('aria-label', name);
        label.append(input);

        return label;
    };
    const control = (label, task, disabled = false) => {
        const b = make('button', label);
        b.type = 'button';
        b.disabled = disabled;
        b.onclick = () => {
            const focus = task();
            draw(focus);
            changed();
        };

        return b;
    };

    function draw(preferred) {
        const model = current();
        controls = [];
        const target = $('reply-buttons-editor');
        target.replaceChildren();

        if (!model || FIELDS[model.module][model.key].fragment) { return; }

        const rows = model.draft.buttons[model.key];
        const register = (input, row, item, name) => {
            controls.push({ input, row, item, name });

            return input;
        };
        rows.forEach((row, index) => {
            const group = make('section', undefined, 'reply-button-row'), header = make('div', undefined, 'actions');
            header.append(make('strong', '第 ' + (index + 1) + ' 行'),
                control('上移', () => {
                    [rows[index - 1], rows[index]] = [rows[index], rows[index - 1]];

                    return row[0];
                }, index === 0),
                control('下移', () => {
                    [rows[index + 1], rows[index]] = [rows[index], rows[index + 1]];

                    return row[0];
                }, index === rows.length - 1),
                control('添加按钮', () => {
                    const item = { action: 'command', label: '帮助', data: model.module === 'pool' ? '/抽奖' : '/兑奖', enter: false };
                    row.push(item);

                    return item;
                }, row.length >= 5),
                control('删除此行', () => {
                    rows.splice(index, 1);

                    return rows[Math.min(index, rows.length - 1)]?.[0];
                }, row.some(b => ['continue', 'next'].includes(b.action))));
            group.append(header);
            row.forEach((item, position) => {
                const box = make('div', undefined, 'reply-button-item'), grid = make('div', undefined, 'grid');
                const label = make('input');
                label.value = item.label;
                label.oninput = () => {
                    item.label = label.value;
                    changed();
                };
                grid.append(field('按钮文字', register(label, index, position, 'label')));
                const action = make('select'), protectedAction = ['continue', 'next'].includes(item.action);
                Object.entries(actions).filter(([key]) => ['command', 'link'].includes(key) || key === item.action).forEach(([key, label]) => {
                    const o = make('option', label);
                    o.value = key;
                    action.append(o);
                });
                action.value = item.action;
                action.disabled = protectedAction;
                action.onchange = () => {
                    item.action = action.value;
                    delete item.data;
                    delete item.enter;

                    if (item.action === 'link') { item.data = 'https://'; } else {
                        item.data = '';
                        item.enter = false;
                    }

                    draw(item);
                    changed();
                };
                const actionField = field('按钮功能', register(action, index, position, 'action'));

                if (protectedAction) { actionField.append(make('span', '原业务参数由程序生成，保留此功能', 'muted')); }

                grid.append(actionField);

                if (['command', 'link'].includes(item.action)) {
                    const data = make('input');
                    data.value = item.data || '';
                    data.oninput = () => {
                        item.data = data.value;
                        changed();
                    };
                    grid.append(field(item.action === 'link' ? '链接地址' : '命令内容', register(data, index, position, 'data')));
                }

                if (item.action !== 'link') {
                    const enter = make('select');
                    [['false', '填入输入框'], ['true', '直接发送命令']].forEach(([value, title]) => {
                        const o = make('option', title);
                        o.value = value;
                        enter.append(o);
                    });
                    enter.value = String(item.enter);
                    enter.onchange = () => {
                        item.enter = enter.value === 'true';
                        changed();
                    };
                    grid.append(field('点击方式', enter));
                }

                const location = make('select');
                rows.forEach((_, i) => {
                    const o = make('option', '第 ' + (i + 1) + ' 行');
                    o.value = String(i);
                    location.append(o);
                });
                location.value = String(index);
                location.onchange = () => {
                    const dest = Number(location.value);

                    if (dest === index) { return; }

                    if (rows[dest].length >= 5) {
                        toast('目标行最多5个按钮', 'warning');

                        return;
                    }

                    row.splice(position, 1);
                    rows[dest].push(item);
                    model.draft.buttons[model.key] = rows.filter(row => row.length);
                    draw(item);
                    changed();
                };
                grid.append(field('所在行', location));
                box.append(grid);
                const moves = make('div', undefined, 'actions');
                moves.append(
                    control('前移', () => {
                        [row[position - 1], row[position]] = [row[position], row[position - 1]];

                        return item;
                    }, position === 0),
                    control('后移', () => {
                        [row[position + 1], row[position]] = [row[position], row[position + 1]];

                        return item;
                    }, position === row.length - 1),
                    control('移除按钮', () => {
                        row.splice(position, 1);
                        model.draft.buttons[model.key] = rows.filter(row => row.length);

                        return row[Math.min(position, row.length - 1)];
                    }, protectedAction));
                box.append(moves);
                group.append(box);
            });
            target.append(group);
        });
        target.append(control('添加一行', () => {
            const item = { action: 'command', label: '帮助', data: '/奖品', enter: false };
            rows.push([item]);

            return item;
        }, rows.length >= 5));

        if (preferred) {
            const found = controls.find(c => rows[c.row]?.[c.item] === preferred && c.name === 'label');
            (found?.input || target.querySelector('button'))?.focus({ preventScroll: true });
        }
    }

    function validate(error) {
        controls.forEach(c => c.input.setAttribute('aria-invalid', String(error?.row === c.row && error?.item === c.item && error?.control === c.name)));

        return controls.find(c => error?.row === c.row && error?.item === c.item && error?.control === c.name)?.input;
    }

    return { draw, validate };
}
`;
