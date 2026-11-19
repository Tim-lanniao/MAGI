import { api, ApiError, errorMessage, isAbort } from '../api';
import { fill, h, nextId } from '../dom';
import { effortLabel, formatDateTime, relativeTime, voterName } from '../format';
import { brandIcon, icon } from '../icons';
import { navigate, type RouteContext } from '../router';
import { markSignedOut } from '../state';
import type { Credential, ModelOption, ModelOptions, ModelSettings, ModelVoter } from '../types';
import { errorState, notice, openDialog, pageHeader, sectionHead, skeleton, toast, withBusy } from '../ui';

const MODEL_VOTERS: ModelVoter[] = ['gpt', 'deepseek'];

export function settingsView(ctx: RouteContext) {
  ctx.setTitle('设置');
  const page = h('div', { class: 'page page-settings' });

  const logout = h('button', { class: 'btn btn-secondary', type: 'button' }, icon('logout'), '退出登录');
  logout.addEventListener('click', () => withBusy(logout, '正在退出…', async () => {
    try {
      await api.logout();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        toast(errorMessage(err), 'error');
        return;
      }
    }
    markSignedOut('已退出登录。');
    navigate('/login', { replace: true });
  }));

  page.append(
    pageHeader({ title: '设置', code: 'CONFIG · 系统设置' }),
    modelsSection(ctx),
    passkeySection(ctx),
    h('section', { class: 'section' }, sectionHead('本次会话'),
      h('div', { class: 'card session-card' }, logout)));
  return page;
}

// ── 模型与思考强度 ─────────────────────────────────────
function modelsSection(ctx: RouteContext) {
  const host = h('div', { class: 'model-host' }, skeleton(3, 'card'));
  const load = () => {
    Promise.all([api.modelSettings(ctx.signal), api.modelOptions(ctx.signal)]).then(([current, options]) => {
      host.replaceChildren(modelForm(current, options));
    }).catch(err => {
      if (isAbort(err)) return;
      host.replaceChildren(errorState(err, () => { host.replaceChildren(skeleton(3, 'card')); load(); }));
    });
  };
  load();
  return h('section', { class: 'section', 'aria-labelledby': 'models-title' }, sectionHead('模型', null, 'models-title'), host);
}

function modelForm(current: ModelSettings, options: ModelOptions) {
  let saved: ModelSettings = structuredClone(current);
  const draft: ModelSettings = structuredClone(current);
  const errorEl = h('p', { class: 'field-error', hidden: true, role: 'alert' });
  const save = h('button', { class: 'btn btn-primary', type: 'submit', disabled: true }, '保存');
  const changed = () => MODEL_VOTERS.filter(v => draft[v].model !== saved[v].model || draft[v].effort !== saved[v].effort);
  const updateDirty = () => { save.disabled = changed().length === 0; };

  const rows = MODEL_VOTERS.map(voter => {
    const catalog = options[voter];
    // 目录里没有当前模型时（例如目录不可用），仍然显示当前选择。
    const list: ModelOption[] = catalog.models.some(m => m.id === draft[voter].model)
      ? catalog.models
      : [{ id: draft[voter].model, label: draft[voter].model, efforts: [draft[voter].effort] }, ...catalog.models];
    const modelId = nextId('model');
    const effortId = nextId('effort');
    const modelSelect = h('select', { id: modelId, class: 'input select', disabled: !catalog.available, 'aria-label': voterName[voter] + ' 模型' },
      list.map(m => h('option', { value: m.id, selected: m.id === draft[voter].model }, m.label)));
    const effortSelect = h('select', { id: effortId, class: 'input select', disabled: !catalog.available, 'aria-label': voterName[voter] + ' 思考强度' });
    const fillEfforts = () => {
      const efforts = list.find(m => m.id === draft[voter].model)?.efforts ?? [draft[voter].effort];
      if (!efforts.includes(draft[voter].effort)) draft[voter].effort = efforts[efforts.length - 1];
      effortSelect.replaceChildren(...efforts.map(e => h('option', { value: e, selected: e === draft[voter].effort }, effortLabel[e] ?? e)));
    };
    fillEfforts();
    modelSelect.addEventListener('change', () => {
      draft[voter].model = modelSelect.value;
      fillEfforts();
      errorEl.hidden = true;
      updateDirty();
    });
    effortSelect.addEventListener('change', () => {
      draft[voter].effort = effortSelect.value as ModelSettings[ModelVoter]['effort'];
      errorEl.hidden = true;
      updateDirty();
    });
    return h('div', { class: ['model-row', 'model-' + voter] },
      h('div', { class: 'model-who', title: voterName[voter] },
        brandIcon(voter, 'brand-icon model-logo'), h('span', { class: 'visually-hidden' }, voterName[voter])),
      h('div', { class: 'field' }, h('label', { class: 'label', for: modelId }, '模型'), modelSelect),
      h('div', { class: 'field' }, h('label', { class: 'label', for: effortId }, '思考强度'), effortSelect),
      catalog.available ? null : h('p', { class: 'hint model-note' }, icon('alert'), '模型目录暂不可用'));
  });

  const form = h('form', { class: 'card model-form', novalidate: true },
    rows, errorEl,
    h('div', { class: 'form-actions' }, save, h('span', { class: 'hint' }, '下次表决生效')));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const voters = changed();
    if (!voters.length) return;
    const body = Object.fromEntries(voters.map(v => [v, draft[v]])) as Partial<ModelSettings>;
    void withBusy(save, '保存中…', async () => {
      try {
        saved = await api.saveModelSettings(body);
        toast('已保存');
      } catch (err) {
        errorEl.textContent = errorMessage(err);
        errorEl.hidden = false;
      }
    }).then(updateDirty);
  });
  return form;
}

// ── Passkey ────────────────────────────────────────
function passkeySection(ctx: RouteContext) {
  const listHost = h('div', { class: 'cred-host' }, skeleton(4, 'card'));
  let editing: string | null = null;
  let credentials: Credential[] = [];

  function render() {
    if (!credentials.length) {
      listHost.replaceChildren(notice('warn', '没有已注册的 Passkey。'));
      return;
    }
    fill(listHost,
      credentials.length === 1 ? notice('warn', '只有一个 Passkey，建议添加备用。') : null,
      h('ul', { class: 'cred-list' }, credentials.map(item)));
  }

  function item(c: Credential) {
    if (editing === c.id) return h('li', { class: 'cred-item is-editing' }, editForm(c));
    const rename = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': '重命名 ' + c.deviceName }, icon('edit'), '重命名');
    rename.addEventListener('click', () => { editing = c.id; render(); listHost.querySelector<HTMLInputElement>('.cred-item.is-editing input')?.focus(); });
    const remove = h('button', { class: 'btn btn-ghost btn-sm btn-danger-text', type: 'button', 'aria-label': '删除 ' + c.deviceName, disabled: credentials.length <= 1 }, icon('trash'), '删除');
    remove.addEventListener('click', () => confirmDelete(c, remove));
    return h('li', { class: 'cred-item' },
      h('div', { class: 'cred-icon' }, icon('passkey')),
      h('div', { class: 'cred-body' },
        h('p', { class: 'cred-name' }, c.deviceName),
        h('p', { class: 'cred-meta' },
          h('span', null, '注册于 ' + formatDateTime(c.createdAt, false)),
          h('span', null, c.lastUsedAt ? '最近使用 ' + relativeTime(c.lastUsedAt) : '尚未用于登录'))),
      h('div', { class: 'cred-actions' }, rename, remove));
  }

  function editForm(c: Credential) {
    const id = nextId('rename');
    const input = h('input', { id, class: 'input', value: c.deviceName, maxlength: '120', autocomplete: 'off' });
    const save = h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, '保存');
    const cancel = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { editing = null; render(); } }, '取消');
    const errorEl = h('p', { class: 'field-error', hidden: true, role: 'alert' });
    const form = h('form', { class: 'cred-edit', novalidate: true },
      h('label', { class: 'label', for: id }, '设备名称'), input, errorEl, h('div', { class: 'form-actions' }, save, cancel));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) {
        errorEl.textContent = '设备名称不能为空。';
        errorEl.hidden = false;
        return;
      }
      void withBusy(save, '保存中…', async () => {
        try {
          await api.renameCredential(c.id, name);
          c.deviceName = name;
          editing = null;
          toast('已重命名');
          render();
        } catch (err) {
          errorEl.textContent = errorMessage(err);
          errorEl.hidden = false;
        }
      });
    });
    return form;
  }

  async function confirmDelete(c: Credential, button: HTMLButtonElement) {
    const choice = await openDialog({
      title: '删除「' + c.deviceName + '」？', tone: 'danger',
      body: h('div', { class: 'prose prose-sm' },
        h('p', null, '删除后这个 Passkey 将无法登录 MAGI。'),
        h('p', null, h('strong', null, '所有设备上的会话都会被注销'), '，包括当前这台，需要重新登录。')),
      actions: [{ label: '取消', value: '', kind: 'ghost' }, { label: '删除并退出', value: 'delete', kind: 'danger' }],
    });
    if (choice !== 'delete') return;
    await withBusy(button, '删除中…', async () => {
      try {
        await api.deleteCredential(c.id);
        markSignedOut('已删除「' + c.deviceName + '」，所有会话已注销。请重新登录。');
        navigate('/login', { replace: true });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return;
        toast(errorMessage(err), 'error');
      }
    });
  }

  function load() {
    api.credentials().then(list => {
      if (ctx.signal.aborted) return;
      credentials = list;
      render();
    }).catch(err => {
      if (isAbort(err)) return;
      listHost.replaceChildren(errorState(err, () => { listHost.replaceChildren(skeleton(4, 'card')); load(); }));
    });
  }
  load();
  return h('section', { class: 'section' }, sectionHead('Passkey'), listHost);
}
