(() => {
  const client = () => window.supabaseClient;
  const $ = id => document.getElementById(id);
  const bucket = 'magma-skins';
  let user = null;
  let profile = null;
  let skinRecord = { skin_path: null, cape_path: null, model: 'default' };
  let preferenceSave = Promise.resolve();
  let refreshTimer = null;

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
    if (!user) {
      setStatus('Войдите в Magma Account', false);
      document.querySelectorAll('#accountCloudSettings input, #accountCloudSettings select, #accountCloudSettings button').forEach(el => el.disabled = true);
      return false;
    }
    document.querySelectorAll('#accountCloudSettings input, #accountCloudSettings select, #accountCloudSettings button').forEach(el => el.disabled = false);
    return true;
  }

  function preferences() {
    return user?.user_metadata?.magma_preferences || {};
  }

  async function savePreferences(patch) {
    preferenceSave = preferenceSave.catch(() => {}).then(async () => {
      if (!user) throw new Error('Войдите в Magma Account.');
      const next = { ...preferences(), ...patch };
      const { data, error } = await client().auth.updateUser({ data: { ...user.user_metadata, magma_preferences: next } });
      if (error) throw error;
      user = data.user;
      window.dispatchEvent(new CustomEvent('magma:account-settings-updated'));
      return user;
    });
    return preferenceSave;
  }

  async function refreshAccount() {
    if (!client()) return;
    if (document.activeElement && $('accountCloudSettings')?.contains(document.activeElement)) return;
    const { data, error } = await client().auth.getUser();
    if (error || !data.user) {
      user = null;
      requireSignedIn();
      return;
    }
    user = data.user;
    const { data: row, error: profileError } = await client().from('profiles').select('nick').eq('id', user.id).maybeSingle();
    if (profileError) throw profileError;
    profile = row || {};
    $('cloudNickname').value = profile.nick || user.user_metadata?.nick || '';
    $('cloudCurrentEmail').textContent = user.email || '—';
    $('cloudHideEmail').checked = !!preferences().hide_profile_email;
    $('cloudProductUpdates').checked = !!preferences().product_updates;
    $('cloudAccountLanguage').value = preferences().language || 'en';
    $('cloudSkinProvider').value = preferences().skin_provider === 'elyby' ? 'elyby' : 'magma';
    try { localStorage.setItem('magma_skin_system', $('cloudSkinProvider').value); } catch {}
    const { data: skin, error: skinError } = await client().from('magma_skins').select('skin_path,cape_path,model').eq('user_id', user.id).maybeSingle();
    if (skinError) throw skinError;
    skinRecord = skin || { skin_path: null, cape_path: null, model: 'default' };
    $('cloudSkinModel').value = skinRecord.model === 'slim' ? 'slim' : 'default';
    setStatus('Синхронизировано', true);
    requireSignedIn();
    const localAccounts = (() => { try { return JSON.parse(localStorage.getItem('magma_accounts') || '[]'); } catch { return []; } })();
    const current = localAccounts.find(item => item.id === user.id);
    if (current && profile.nick && current.nickname !== profile.nick) {
      current.nickname = profile.nick;
      localStorage.setItem('magma_accounts', JSON.stringify(localAccounts));
      const name = $('accountName');
      if (name && localStorage.getItem('magma_active_account_id') === user.id) name.textContent = profile.nick;
      $('settingsAccountName').textContent = profile.nick;
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
      const localAccounts = (() => { try { return JSON.parse(localStorage.getItem('magma_accounts') || '[]'); } catch { return []; } })();
      const current = localAccounts.find(item => item.id === user.id);
      if (current) { current.nickname = nickname; localStorage.setItem('magma_accounts', JSON.stringify(localAccounts)); }
      if ($('accountName')) $('accountName').textContent = nickname;
      if ($('settingsAccountName')) $('settingsAccountName').textContent = nickname;
      message('cloudNicknameMessage', 'Ник сохранён и синхронизирован.', true);
    } catch (error) { message('cloudNicknameMessage', error.message || 'Не удалось сохранить ник.'); }
    finally { button.disabled = false; }
  }

  async function changePassword() {
    const current = $('cloudCurrentPassword').value;
    const next = $('cloudNewPassword').value;
    const confirm = $('cloudConfirmPassword').value;
    if (!current) return message('cloudPasswordMessage', 'Введите текущий пароль.');
    if (next.length < 6) return message('cloudPasswordMessage', 'Новый пароль должен содержать минимум 6 символов.');
    if (next !== confirm) return message('cloudPasswordMessage', 'Пароли не совпадают.');
    const button = $('cloudChangePassword');
    button.disabled = true;
    try {
      const { error } = await client().auth.updateUser({ password: next, current_password: current });
      if (error) throw error;
      $('cloudCurrentPassword').value = '';
      $('cloudNewPassword').value = '';
      $('cloudConfirmPassword').value = '';
      message('cloudPasswordMessage', 'Пароль успешно изменён.', true);
    } catch (error) { message('cloudPasswordMessage', error.message || 'Не удалось изменить пароль.'); }
    finally { button.disabled = false; }
  }

  async function changeEmail() {
    const email = $('cloudNewEmail').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return message('cloudEmailMessage', 'Введите корректный адрес почты.');
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

  async function validatePng(file, type) {
    if (!file || file.type !== 'image/png' || file.size > 2 * 1024 * 1024) throw new Error('Выберите PNG-файл размером не более 2 МБ.');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      const valid = type === 'skin' ? image.width === 64 && [32, 64].includes(image.height) : image.width === 64 && image.height === 32;
      if (!valid) throw new Error(type === 'skin' ? 'Размер скина должен быть 64×64 или 64×32.' : 'Размер плаща должен быть 64×32.');
    } finally { URL.revokeObjectURL(url); }
  }

  async function saveSkinField(type, file) {
    message('cloudSkinMessage', 'Сохраняем изменения…');
    try {
      await validatePng(file, type);
      const path = user.id + '/' + type + '.png';
      const { error: uploadError } = await client().storage.from(bucket).upload(path, file, { contentType: 'image/png', upsert: true, cacheControl: '0' });
      if (uploadError) throw uploadError;
      skinRecord[type + '_path'] = path;
      await persistSkin();
      message('cloudSkinMessage', (type === 'skin' ? 'Скин' : 'Плащ') + ' загружен и сохранён в облаке.', true);
    } catch (error) { message('cloudSkinMessage', error.message || 'Не удалось загрузить текстуру.'); }
  }

  async function persistSkin() {
    const next = { user_id: user.id, skin_path: skinRecord.skin_path || null, cape_path: skinRecord.cape_path || null, model: $('cloudSkinModel').value, updated_at: new Date().toISOString() };
    const { error } = await client().from('magma_skins').upsert(next, { onConflict: 'user_id' });
    if (error) throw error;
    skinRecord = next;
    window.dispatchEvent(new CustomEvent('magma:account-settings-updated'));
  }

  async function removeSkinField(type) {
    const field = type + '_path';
    const path = skinRecord[field];
    if (!path) return message('cloudSkinMessage', type === 'skin' ? 'Скин не загружен.' : 'Плащ не загружен.');
    const next = { ...skinRecord, [field]: null };
    try {
      const { error } = await client().from('magma_skins').upsert({ user_id: user.id, skin_path: next.skin_path || null, cape_path: next.cape_path || null, model: $('cloudSkinModel').value, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) throw error;
      skinRecord = next;
      window.dispatchEvent(new CustomEvent('magma:account-settings-updated'));
      const { error: removeError } = await client().storage.from(bucket).remove([path]);
      if (removeError) console.warn('[Magma Account] Texture reference removed, storage cleanup failed:', removeError);
      message('cloudSkinMessage', type === 'skin' ? 'Скин удалён.' : 'Плащ удалён.', true);
    } catch (error) { message('cloudSkinMessage', error.message || 'Не удалось удалить текстуру.'); }
  }

  async function signOutOthers() {
    if (!confirm('Завершить все остальные сеансы Magma Account? Этот лаунчер останется подключён.')) return;
    try {
      const { error } = await client().auth.signOut({ scope: 'others' });
      if (error) throw error;
      message('cloudSessionsMessage', 'Остальные сеансы завершены.', true);
    } catch (error) { message('cloudSessionsMessage', error.message || 'Не удалось завершить сеансы.'); }
  }

  async function deleteAccount() {
    if (!confirm('Удалить Magma Account навсегда вместе с профилем и загруженными скинами?')) return;
    if (!confirm('Подтвердите окончательное удаление аккаунта. Это действие нельзя отменить.')) return;
    const button = $('cloudDeleteAccount');
    button.disabled = true;
    try {
      const { error } = await client().functions.invoke('delete-account', { body: {} });
      if (error) throw error;
      await client().auth.signOut({ scope: 'local' });
      setStatus('Аккаунт удалён');
      message('cloudDangerMessage', 'Аккаунт удалён.', true);
      if (window.handleMagmaAccountDeleted) await window.handleMagmaAccountDeleted();
    } catch (error) {
      message('cloudDangerMessage', error.message || 'Не удалось удалить аккаунт.');
      button.disabled = false;
    }
  }

  async function saveToggle(id, key) {
    try {
      await savePreferences({ [key]: $(id).checked });
      message('cloudPreferencesMessage', 'Настройка сохранена и синхронизирована.', true);
    } catch (error) { message('cloudPreferencesMessage', error.message || 'Не удалось сохранить настройку.'); }
  }

  async function bind() {
    if (!$('accountCloudSettings') || !client()) return;
    $('cloudSaveNickname').addEventListener('click', saveNickname);
    $('cloudChangePassword').addEventListener('click', changePassword);
    $('cloudChangeEmail').addEventListener('click', changeEmail);
    $('cloudHideEmail').addEventListener('change', () => saveToggle('cloudHideEmail', 'hide_profile_email'));
    $('cloudProductUpdates').addEventListener('change', () => saveToggle('cloudProductUpdates', 'product_updates'));
    $('cloudAccountLanguage').addEventListener('change', async () => {
      try { await savePreferences({ language: $('cloudAccountLanguage').value }); message('cloudPreferencesMessage', 'Язык аккаунта сохранён и синхронизирован.', true); }
      catch (error) { message('cloudPreferencesMessage', error.message || 'Не удалось сохранить язык.'); }
    });
    $('cloudSkinProvider').addEventListener('change', async () => {
      try { await savePreferences({ skin_provider: $('cloudSkinProvider').value }); try { localStorage.setItem('magma_skin_system', $('cloudSkinProvider').value); } catch {} window.dispatchEvent(new CustomEvent('magma:account-settings-updated'));
      message('cloudSkinMessage', 'Источник скинов сохранён.', true); }
      catch (error) { message('cloudSkinMessage', error.message || 'Не удалось сохранить источник.'); }
    });
    $('cloudSkinModel').addEventListener('change', async () => {
      try { await persistSkin(); message('cloudSkinMessage', 'Модель игрока сохранена.', true); }
      catch (error) { message('cloudSkinMessage', error.message || 'Не удалось сохранить модель.'); }
    });
    $('cloudSkinFile').addEventListener('change', event => { if (event.target.files[0]) saveSkinField('skin', event.target.files[0]); });
    $('cloudCapeFile').addEventListener('change', event => { if (event.target.files[0]) saveSkinField('cape', event.target.files[0]); });
    $('cloudRemoveSkin').addEventListener('click', () => removeSkinField('skin'));
    $('cloudRemoveCape').addEventListener('click', () => removeSkinField('cape'));
    $('cloudSignOutOthers').addEventListener('click', signOutOthers);
    $('cloudDeleteAccount').addEventListener('click', deleteAccount);
    $('cloudSignOut').addEventListener('click', () => {
      const logoutButton = $('accountLogoutBtn');
      if (logoutButton) logoutButton.click();
      else client().auth.signOut({ scope: 'local' }).then(({ error }) => {
        if (error) message('cloudDangerMessage', error.message);
        else { user = null; setStatus('Вы вышли из аккаунта'); requireSignedIn(); }
      });
    });
    client().auth.onAuthStateChange((_event, session) => {
      user = session?.user || null;
      if (user) refreshAccount().catch(error => { setStatus('Ошибка синхронизации'); console.error(error); });
      else { user = null; requireSignedIn(); }
    });
    await refreshAccount().catch(error => { setStatus('Ошибка синхронизации'); console.error('[Magma Account]', error); });
    window.addEventListener('focus', () => refreshAccount().catch(console.error));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAccount().catch(console.error); });
    refreshTimer = setInterval(() => refreshAccount().catch(console.error), 30000);
  }

  document.addEventListener('DOMContentLoaded', bind);
})();