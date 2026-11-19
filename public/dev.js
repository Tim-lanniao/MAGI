'use strict';
const statusView = document.querySelector('#status');
const invitation = new URLSearchParams(location.search).get('token');
if (invitation) history.replaceState(null, '', location.pathname);
const register = document.querySelector('#register');
register.hidden = !invitation;
const show = value => { statusView.textContent = typeof value === 'string' ? value : JSON.stringify(value,null,2); };
async function post(path, body) {
  const response = await fetch('/api/' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error.message), { data });
  return data;
}
register.onsubmit = async event => {
  event.preventDefault();
  try {
    const optionsJSON = await post('auth/register/options', { inviteToken: invitation, deviceName: register.elements.device.value });
    const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON });
    await post('auth/register/verify', { inviteToken: invitation, response });
    register.hidden = true;
    show('注册完成，可以登录。');
  } catch (err) { show(err.message); }
};
document.querySelector('#login').onclick = async () => {
  try {
    const optionsJSON = await post('auth/login/options', {});
    const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON });
    await post('auth/login/verify', { response });
    show('已登录。');
  } catch (err) { show(err.message); }
};
const form = document.querySelector('#question');
form.onsubmit = async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  if (button.disabled) return;
  button.disabled = true;
  const data = Object.fromEntries(new FormData(form));
  const body = { question: data.question, background: data.background, goals: data.goals, reversibility: data.reversibility,
    userVote: { vote: data.vote, confidence: Number(data.confidence), core_reason: data.reason, conditions: [], risks: [], flip_condition: '' } };
  try {
    let created;
    try { created = await post('questions',body); }
    catch (err) {
      if (err.data?.error?.code !== 'LINT_WARNINGS' || !window.confirm('背景包含：' + err.data.warnings.map(w => w.phrase).join('、') + '。仍要提交吗？')) throw err;
      created = await post('questions', { ...body, acknowledgeWarnings: true });
    }
    show(created);
    async function poll() {
      try {
        const response = await fetch('/api/questions/' + created.id, { cache: 'no-store' });
        const detail = await response.json();
        show(detail);
        if (response.ok && detail.status === 'running') setTimeout(poll,3000);
      } catch (err) { show(err.message); }
    }
    setTimeout(poll,3000);
  } catch (err) { button.disabled = false; show(err.message); }
};
