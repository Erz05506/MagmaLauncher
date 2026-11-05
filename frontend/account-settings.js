(() => {
  const client = () => window.supabaseClient;
  const $ = id => document.getElementById(id);
  let user = null;
  let preferenceSave = Promise.resolve();

  function message(id, value, success = false) {
    const el = $(id);
    if (!el) return;
    el.textContent = value || '';
    el.classList.toggle('is-success', !!success);
    el.classList.toggle('is-error', !!value && !success);
  }

  function setStatus(value, good = false) {
    const el = $('accountCloudStatus');
    if (!el) return;
    el.textContent = value;
    el.classList.toggle('is-online', good);
  }

  function requireSignedIn() {
    document.querySelectorAll('#accountCloudSettings input, #accountCloudSettings button').forEach(el => { el.disabled = !user; });
    if (!user) setStatus('Войдите в аккаунт');
  }

  function preferences() { return user?.user_metadata?.magma_preferences || {}; }

  async function savePreferences(patch) {
    preferenceSave = preferenceSave.catch(() => {}).then(async () => {
      if (!user) throw new Error('Войдите в аккаунт.');
      const { data, error } = await client().auth.updateUser({ data: { ...user.user_metadata, magma_preferences: { ...preferences(), ...patch } } });
      if (error) throw error;
      user = data.user;
      window.dispatchEvent(new CustomEvent('magma:account-settings-updated'));
      return user;
    });
    return preferenceSave;
  }

  async function refreshAccount() {
    if (!client() || !$('accountCloudSettings')) return;
    if (document.activeElement && $('accountCloudSettings').contains(document.activeElement)) return;
    const { data, error } = await client().auth.getUser();
    if (error || !data.user) { user = null; requireSignedIn(); return; }
    user = data.user;
    const { data: row, error: profileError } = await client().from('profiles').select('nick').eq('id', user.id).maybeSingle();
    if (profileError) throw profileError;
    const nickname = row?.nick || user.user_metadata?.nick || '';
    $('cloudNickname').value = nickname;
    $('cloudNicknameCurrent').textContent = nickname || 'Не задан';
    $('cloudCurrentEmail').textContent = user.email || '—';
    const provider = preferences().skin_provider === 'elyby' ? 'elyby' : 'magma';
    document.querySelectorAll('#accountSkinSystemOptions [data-skin-system]').forEach(button => button.classList.toggle('is-active', button.dataset.skinSystem === provider));
    try { localStorage.setItem('magma_skin_system', provider); } catch {}
    setStatus('Синхронизировано', true);
    requireSignedIn();
    const accounts = (() => { try { return JSON.parse(localStorage.getItem('magma_accounts') || '[]'); } catch { return []; } })();
    const current = accounts.find(item => item.id === user.id);
    if (current && nickname && current.nickname !== nickname) {
      current.nickname = nickname;
      localStorage.setItem('magma_accounts', JSON.stringify(accounts));
      if ($('accountName') && localStorage.getItem('magma_active_account_id') === user.id) $('accountName').textContent = nickname;
      if ($('settingsAccountName')) $('settingsAccountName').textContent = nickname;
    }
  }

  async function saveNickname() {
    message('cloudNicknameMessage', '');
    const nickname = $('cloudNickname').value.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(nickname)) return message('cloudNicknameMessage', 'Ник должен содержать 3–16 латинских букв, цифр или _.');
    const button = $('cloudSaveNickname');
    button.disabled = true;
    try {
      const { error } = await client().from('profiles').update({ nick: nickname }).eq('id', user.id);
      if (error?.code === '23505') throw new Error('Этот ник уже занят.');
      if (error) throw error;
      const { data, error: authError } = await client().auth.updateUser({ data: { ...user.user_metadata, nick: nickname } });
      if (authError) throw authError;
      user = data.user;
      $('cloudNicknameCurrent').textContent = nickname;
      $('settingsAccountName').textContent = nickname;
      if ($('accountName') && localStorage.getItem('magma_active_account_id') === user.id) $('accountName').textContent = nickname;
      const accounts = (() => { try { return JSON.parse(localStorage.getItem('magma_accounts') || '[]'); } catch { return []; } })();
      const current = accounts.find(item => item.id === user.id);
      if (current) { current.nickname = nickname; localStorage.setItem('magma_accounts', JSON.stringify(accounts)); }
      $('accountNicknameEditor').hidden = true;
      message('cloudNicknameMessage', 'Никнейм сохранён.', true);
    } catch (error) { message('cloudNicknameMessage', error.message || 'Не удалось сохранить никнейм.'); }
    finally { button.disabled = false; }
  }

  async function changeEmail() {
    const email = $('cloudNewEmail').value.trim().toLowerCase();
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return message('cloudEmailMessage', 'Введите корректный адрес почты.');
    if (email === user.email?.toLowerCase()) return message('cloudEmailMessage', 'Это уже текущий адрес.');
    const button = $('cloudChangeEmail');
    button.disabled = true;
    try {
      const { error } = await client().auth.updateUser({ email }, { emailRedirectTo: 'https://magmalauncher.space/pages/account.html' });
      if (error) throw error;
      $('cloudNewEmail').value = '';
      message('cloudEmailMessage', 'Письмо подтверждения отправлено. Новый адрес вступит в силу после подтверждения.', true);
    } catch (error) { message('cloudEmailMessage', error.message || 'Не удалось изменить почту.'); }
    finally { button.disabled = false; }
  }

  function toggleEditor(id) {
    const editor = $(id);
    editor.hidden = !editor.hidden;
    if (!editor.hidden) editor.querySelector('input')?.focus();
  }

  async function bind() {
    if (!$('accountCloudSettings') || !client()) return;
    $('accountNicknameToggle').addEventListener('click', () => toggleEditor('accountNicknameEditor'));
    $('accountEmailToggle').addEventListener('click', () => toggleEditor('accountEmailEditor'));
    $('accountNicknameCancel').addEventListener('click', () => { $('accountNicknameEditor').hidden = true; });
    $('accountEmailCancel').addEventListener('click', () => { $('accountEmailEditor').hidden = true; });
    $('cloudSaveNickname').addEventListener('click', saveNickname);
    $('cloudChangeEmail').addEventListener('click', changeEmail);

    document.querySelectorAll('#accountSkinSystemOptions [data-skin-system]').forEach(button => {
      button.addEventListener('click', async () => {
        const provider = button.dataset.skinSystem;
        document.querySelectorAll('#accountSkinSystemOptions [data-skin-system]').forEach(item => item.classList.toggle('is-active', item === button));
        try {
          localStorage.setItem('magma_skin_system', provider);
          if (user) await savePreferences({ skin_provider: provider });
          message('cloudSkinMessage', 'Источник скинов сохранён.', true);
          window.dispatchEvent(new CustomEvent('magma:account-settings-updated'));
        } catch (error) { message('cloudSkinMessage', error.message || 'Не удалось сохранить источник скинов.'); }
      });
    });

    client().auth.onAuthStateChange((_event, session) => {
      user = session?.user || null;
      if (user) refreshAccount().catch(error => { setStatus('Ошибка синхронизации'); console.error('[Magma Account]', error); });
      else { user = null; requireSignedIn(); }
    });
    await refreshAccount().catch(error => { setStatus('Ошибка синхронизации'); console.error('[Magma Account]', error); });
    window.addEventListener('focus', () => refreshAccount().catch(console.error));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAccount().catch(console.error); });
  }

  document.addEventListener('DOMContentLoaded', bind);
})();