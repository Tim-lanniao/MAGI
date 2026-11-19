import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api, ApiError, errorMessage } from '../api';
import { fill, h, nextId, session } from '../dom';
import { guessDeviceName } from '../format';
import { icon } from '../icons';
import { navigate, type RouteContext } from '../router';
import { appState, markSignedIn, safeNext, takeNotice } from '../state';
import { notice, withBusy } from '../ui';

/** 把 WebAuthn 浏览器端异常翻译成可操作的中文说明。 */
function passkeyError(err: unknown, ceremony: 'register' | 'login') {
  if (err instanceof ApiError) return err.message;
  const e = err as { name?: string; code?: string; cause?: { name?: string } } | null;
  const name = e?.cause?.name ?? e?.name;
  if (e?.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || name === 'InvalidStateError') {
    return '这台设备上已有为 MAGI 注册的 Passkey，可以直接登录。';
  }
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return ceremony === 'login'
      ? '登录已取消或超时。'
      : '注册已取消或超时，请重试。';
  }
  if (name === 'SecurityError') return '当前地址不能使用 Passkey。请通过 MAGI 的 HTTPS 正式域名打开。';
  if (name === 'NotSupportedError' || e?.code?.startsWith('ERROR_AUTHENTICATOR_MISSING')) {
    return '这台设备的验证器不支持所需的 Passkey 类型（需要可发现凭证与用户验证）。';
  }
  return errorMessage(err);
}

function authFrame(...children: (Node | null)[]) {
  return h('div', { class: 'auth-page' },
    h('div', { class: 'auth-card' },
      h('div', { class: 'auth-brand', 'aria-hidden': 'true' },
        h('span', { class: 'brand-mark brand-mark-lg' }, h('i'), h('i'), h('i')),
        h('span', { class: 'auth-brand-text' },
          h('span', { class: 'auth-brand-name' }, 'MAGI'),
          h('span', { class: 'auth-brand-code' }, 'TRI-VOTE DECISION SYSTEM'))),
      ...children));
}

export function loginView(ctx: RouteContext) {
  ctx.setTitle('登录');
  const next = safeNext(ctx.query.get('next'));
  const message = takeNotice();
  const status = h('div', { class: 'auth-status', role: 'alert', hidden: true });
  const supported = browserSupportsWebAuthn();

  const button = h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'button', disabled: !supported },
    icon('passkey'), '用 Passkey 登录');
  button.addEventListener('click', () => withBusy(button, '等待验证…', async () => {
    status.hidden = true;
    try {
      const optionsJSON = await api.loginOptions();
      const response = await startAuthentication({ optionsJSON: optionsJSON as never });
      await api.loginVerify(response);
      markSignedIn();
      navigate(next, { replace: true });
    } catch (err) {
      status.replaceChildren(notice('danger', passkeyError(err, 'login')));
      status.hidden = false;
    }
  }));

  return authFrame(
    h('h1', { class: 'auth-title' }, '登录 MAGI'),
    message ? notice('info', message) : null,
    supported ? null : notice('warn', '当前浏览器不支持 Passkey。请使用最新版 Safari、Chrome 或 Edge。'),
    button,
    status,
  );
}

const INVITE_KEY = 'magi:invite';

export function setupView(ctx: RouteContext) {
  ctx.setTitle('注册 Passkey');
  // 从地址栏移除邀请令牌，避免留在历史记录或截图中；在本标签页内暂存以便刷新。
  const fromUrl = ctx.query.get('token');
  if (fromUrl) {
    session.set(INVITE_KEY, fromUrl);
    history.replaceState(history.state, '', '/setup');
  }
  const token = fromUrl ?? session.get(INVITE_KEY);
  const supported = browserSupportsWebAuthn();

  if (!token) {
    return authFrame(
      h('h1', { class: 'auth-title' }, '缺少邀请'),
      h('p', { class: 'auth-lead' }, '请使用有效的邀请链接打开。'),
      h('a', { class: 'btn btn-secondary btn-block', href: '/login' }, '已有 Passkey，去登录'),
    );
  }

  const status = h('div', { class: 'auth-status', role: 'alert', hidden: true });
  const inputId = nextId('device');
  const input = h('input', {
    id: inputId, class: 'input', name: 'device', required: true, maxlength: '120', autocomplete: 'off',
    value: guessDeviceName(), enterkeyhint: 'done',
  });
  const submit = h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit', disabled: !supported },
    icon('passkey'), '注册这台设备的 Passkey');

  const body = h('div', { class: 'auth-body' });
  const form = h('form', { class: 'auth-form', novalidate: true },
    h('div', { class: 'field' },
      h('label', { class: 'label', for: inputId }, '设备名称'),
      input),
    submit, status);

  form.addEventListener('submit', event => {
    event.preventDefault();
    const deviceName = input.value.trim();
    if (!deviceName) {
      status.replaceChildren(notice('danger', '请填写设备名称。'));
      status.hidden = false;
      input.focus();
      return;
    }
    withBusy(submit, '等待设备验证…', async () => {
      status.hidden = true;
      try {
        const optionsJSON = await api.registerOptions(token, deviceName);
        const response = await startRegistration({ optionsJSON: optionsJSON as never });
        await api.registerVerify(token, response);
        session.remove(INVITE_KEY);
        showDone(deviceName);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'INVALID_INVITE') session.remove(INVITE_KEY);
        status.replaceChildren(notice('danger', passkeyError(err, 'register')));
        status.hidden = false;
      }
    });
  });

  function showDone(deviceName: string) {
    const signedIn = appState.auth === 'in';
    const loginButton = h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'button' }, icon('passkey'), '用刚注册的 Passkey 登录');
    const loginStatus = h('div', { class: 'auth-status', role: 'alert', hidden: true });
    loginButton.addEventListener('click', () => withBusy(loginButton, '等待验证…', async () => {
      loginStatus.hidden = true;
      try {
        const optionsJSON = await api.loginOptions();
        const response = await startAuthentication({ optionsJSON: optionsJSON as never });
        await api.loginVerify(response);
        markSignedIn();
        navigate('/', { replace: true });
      } catch (err) {
        loginStatus.replaceChildren(notice('danger', passkeyError(err, 'login')));
        loginStatus.hidden = false;
      }
    }));
    body.replaceChildren(
      h('div', { class: 'auth-success' }, icon('check', 'icon success-icon'),
        h('h1', { class: 'auth-title', tabindex: '-1' }, '注册完成'),
        h('p', { class: 'auth-lead' }, '「' + deviceName + '」已可用于登录。')),
      signedIn
        ? h('a', { class: 'btn btn-primary btn-block btn-lg', href: '/settings' }, '返回设置')
        : loginButton,
      loginStatus,
    );
    body.querySelector<HTMLElement>('h1')?.focus();
  }

  fill(body,
    h('h1', { class: 'auth-title' }, '注册 Passkey'),
    supported ? null : notice('warn', '当前浏览器不支持 Passkey。请使用最新版 Safari、Chrome 或 Edge。'),
    form,
  );
  return authFrame(body);
}
