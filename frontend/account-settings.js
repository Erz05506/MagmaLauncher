(() => {
  const client = () => window.supabaseClient;
  const $ = id => document.getElementById(id);
  let user = null;
  let preferenceSave = Promise.resolve();
  let skinRecord = { skin_path: null, cape_path: null, model: 'default' };

  function tr(key, fallback) {
    const value = window.t?.(key);
    return value && value !== key ? value : fallback;
  }

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
    document.querySelectorAll('#accountCloudSettings input, #accountCloudSettings button, #accountCloudSettings select').forEach(el => { el.disabled = !user; });
    if (!user) setStatus(tr('settings.account.signInRequired', 'Войдите в аккаунт'));
  }

  function preferences() { return user?.user_metadata?.magma_preferences || {}; }

  async function savePreferences(patch) {
    preferenceSave = preferenceSave.catch(() => {}).then(async () => {
      if (!user) throw new Error(tr('settings.account.signInRequired', 'Войдите в аккаунт'));
      const { data, error } = await client().auth.updateUser({ data: { ...user.user_metadata, magma_preferences: { ...preferences(), ...patch } } });
      if (error) throw error;
      user = data.user;
      window.dispatchEvent(new CustomEvent('magma:account-settings-updated'));
      return user;
    });
    return preferenceSave;
  }

  async function loadSkinRecord() {
    const { data, error } = await client().from('magma_skins').select('skin_path,cape_path,model').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    skinRecord = data || { skin_path: null, cape_path: null, model: 'default' };
    $('accountSkinModel').value = skinRecord.model === 'slim' ? 'slim' : 'default';
  }

  function updateSkinControls(provider) {
    const controls = $('accountSkinManager');
    if (controls) controls.hidden = provider !== 'magma';
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
    $('cloudNicknameCurrent').textContent = nickname || tr('settings.account.notSet', 'Не задан');
    $('cloudCurrentEmail').textContent = user.email || '—';
    const provider = preferences().skin_provider === 'elyby' ? 'elyby' : 'magma';
    document.querySelectorAll('#accountSkinSystemOptions [data-skin-system]').forEach(button => button.classList.toggle('is-active', button.dataset.skinSystem === provider));
    $('accountHideProfileEmail').checked = !!preferences().hide_profile_email;
    $('accountProductUpdates').checked = !!preferences().product_updates;
    updateSkinControls(provider);
    if (provider === 'magma') await loadSkinRecord();
    try { localStorage.setItem('magma_skin_system', provider); } catch {}
    setStatus(tr('settings.account.synced', 'Синхронизировано'), true);
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
    if (!/^[A-Za-z0-9_]{3,16}$/.test(nickname)) return message('cloudNicknameMessage', tr('settings.account.nicknameInvalid', 'Ник должен содержать 3–16 латинских букв, цифр или _.'));
    const button = $('cloudSaveNickname');
    button.disabled = true;
    try {
      const { error } = await client().from('profiles').update({ nick: nickname }).eq('id', user.id);
      if (error?.code === '23505') throw new Error(tr('settings.account.nicknameTaken', 'Этот ник уже занят.'));
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
      message('cloudNicknameMessage', tr('settings.account.nicknameSaved', 'Никнейм сохранён.'), true);
    } catch (error) { message('cloudNicknameMessage', error.message || tr('settings.account.nicknameFailed', 'Не удалось сохранить никнейм.')); }
    finally { button.disabled = false; }
  }

  async function changeEmail() {
    const email = $('cloudNewEmail').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return message('cloudEmailMessage', tr('settings.account.emailInvalid', 'Введите корректный адрес почты.'));
    if (email === user.email?.toLowerCase()) return message('cloudEmailMessage', tr('settings.account.emailSame', 'Это уже текущий адрес.'));
    const button = $('cloudChangeEmail');
    button.disabled = true;
    try {
      const { error } = await client().auth.updateUser({ email }, { emailRedirectTo: 'https://magmalauncher.space/pages/account.html' });
      if (error) throw error;
      $('cloudNewEmail').value = '';
      message('cloudEmailMessage', tr('settings.account.emailSent', 'Письмо подтверждения отправлено. Новый адрес вступит в силу после подтверждения.'), true);
    } catch (error) { message('cloudEmailMessage', error.message || tr('settings.account.emailFailed', 'Не удалось изменить почту.')); }
    finally { button.disabled = false; }
  }

  function toggleEditor(id) {
    const editor = $(id);
    editor.hidden = !editor.hidden;
    if (!editor.hidden) editor.querySelector('input')?.focus();
  }

  function validatePng(file, kind) {
    return new Promise((resolve, reject) => {
      if (!file || file.type !== 'image/png') return reject(new Error(tr('settings.account.pngOnly', 'Выберите PNG-файл.')));
      if (file.size > 2 * 1024 * 1024) return reject(new Error(tr('settings.account.imageTooLarge', 'Размер изображения не должен превышать 2 МБ.')));
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(url);
        const valid = kind === 'skin'
          ? image.width === 64 && (image.height === 64 || image.height === 32)
          : image.width === 64 && image.height === 32;
        if (!valid) return reject(new Error(kind === 'skin'
          ? tr('settings.account.skinDimensions', 'Размер скина должен быть 64×64 или 64×32 пикселя.')
          : tr('settings.account.capeDimensions', 'Размер плаща должен быть 64×32 пикселя.')));
        resolve(file);
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(tr('settings.account.imageReadFailed', 'Не удалось прочитать PNG-файл.'))); };
      image.src = url;
    });
  }

  async function saveSkinTexture(file, kind) {
    if (!user) throw new Error(tr('settings.account.signInRequired', 'Войдите в аккаунт'));
    if (preferences().skin_provider === 'elyby') return;
    const validFile = await validatePng(file, kind);
    const path = user.id + '/' + kind + '.png';
    const { error: uploadError } = await client().storage.from('magma-skins').upload(path, validFile, {
      contentType: 'image/png', upsert: true, cacheControl: '0'
    });
    if (uploadError) throw uploadError;
    const next = {
      user_id: user.id,
      skin_path: skinRecord.skin_path || null,
      cape_path: skinRecord.cape_path || null,
      model: skinRecord.model === 'slim' ? 'slim' : 'default',
      updated_at: new Date().toISOString()
    };
    next[kind + '_path'] = path;
    const { error } = await client().from('magma_skins').upsert(next, { onConflict: 'user_id' });
    if (error) throw error;
    skinRecord = next;
    await refreshPreview();
    message('cloudSkinManagerMessage', tr('settings.account.textureSaved', 'Изменения сохранены.'), true);
  }

  async function removeSkinTexture(kind) {
    if (!user || preferences().skin_provider === 'elyby') return;
    const oldPath = skinRecord[kind + '_path'];
    const next = {
      user_id: user.id,
      skin_path: skinRecord.skin_path || null,
      cape_path: skinRecord.cape_path || null,
      model: skinRecord.model === 'slim' ? 'slim' : 'default',
      updated_at: new Date().toISOString()
    };
    next[kind + '_path'] = null;
    const { error } = await client().from('magma_skins').upsert(next, { onConflict: 'user_id' });
    if (error) throw error;
    skinRecord = next;
    if (oldPath) {
      const { error: removeError } = await client().storage.from('magma-skins').remove([oldPath]);
      if (removeError) console.warn('[Magma Skins] Could not remove old texture:', removeError);
    }
    await refreshPreview();
    message('cloudSkinManagerMessage', tr('settings.account.textureRemoved', 'Текстура удалена.'), true);
  }

  async function saveSkinModel() {
    if (!user || preferences().skin_provider === 'elyby') return;
    const next = {
      user_id: user.id,
      skin_path: skinRecord.skin_path || null,
      cape_path: skinRecord.cape_path || null,
      model: $('accountSkinModel').value === 'slim' ? 'slim' : 'default',
      updated_at: new Date().toISOString()
    };
    const { error } = await client().from('magma_skins').upsert(next, { onConflict: 'user_id' });
    if (error) throw error;
    skinRecord = next;
    await refreshPreview();
  }

  async function refreshPreview() {
    window.magmaRefreshAccountSkinViewer?.($('cloudNicknameCurrent').textContent);
  }

  async function saveAccountPreferences() {
    const button = $('accountSavePreferences');
    button.disabled = true;
    message('cloudAccountPreferencesMessage', '');
    try {
      await savePreferences({
        hide_profile_email: $('accountHideProfileEmail').checked,
        product_updates: $('accountProductUpdates').checked
      });
      message('cloudAccountPreferencesMessage', tr('settings.account.preferencesSaved', 'Настройки сохранены.'), true);
    } catch (error) {
      message('cloudAccountPreferencesMessage', error.message || tr('settings.account.preferencesFailed', 'Не удалось сохранить настройки.'));
    } finally { button.disabled = false; }
  }

  async function signOutOtherSessions() {
    const button = $('accountSignOutOtherSessions');
    button.disabled = true;
    message('cloudSessionsMessage', '');
    try {
      const { error } = await client().auth.signOut({ scope: 'others' });
      if (error) throw error;
      message('cloudSessionsMessage', tr('settings.account.sessionsSignedOut', 'Другие сеансы завершены. Текущий сеанс остался активным.'), true);
    } catch (error) {
      message('cloudSessionsMessage', error.message || tr('settings.account.sessionsFailed', 'Не удалось завершить другие сеансы.'));
    } finally { button.disabled = false; }
  }

  async function bind() {
    if (!$('accountCloudSettings') || !client()) return;
    $('accountNicknameToggle').addEventListener('click', () => toggleEditor('accountNicknameEditor'));
    $('accountEmailToggle').addEventListener('click', () => toggleEditor('accountEmailEditor'));
    $('accountNicknameCancel').addEventListener('click', () => { $('accountNicknameEditor').hidden = true; });
    $('accountEmailCancel').addEventListener('click', () => { $('accountEmailEditor').hidden = true; });
    $('cloudSaveNickname').addEventListener('click', saveNickname);
    $('cloudChangeEmail').addEventListener('click', changeEmail);
    $('accountSavePreferences').addEventListener('click', saveAccountPreferences);
    $('accountSignOutOtherSessions').addEventListener('click', signOutOtherSessions);
    $('accountUploadSkin').addEventListener('click', () => $('accountSkinFile').click());
    $('accountUploadCape').addEventListener('click', () => $('accountCapeFile').click());
    $('accountSkinFile').addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try { await saveSkinTexture(file, 'skin'); }
      catch (error) { message('cloudSkinManagerMessage', error.message || tr('settings.account.textureFailed', 'Не удалось загрузить скин.')); }
      finally { event.target.value = ''; }
    });
    $('accountCapeFile').addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try { await saveSkinTexture(file, 'cape'); }
      catch (error) { message('cloudSkinManagerMessage', error.message || tr('settings.account.textureFailed', 'Не удалось загрузить плащ.')); }
      finally { event.target.value = ''; }
    });
    $('accountRemoveSkin').addEventListener('click', async () => {
      try { await removeSkinTexture('skin'); }
      catch (error) { message('cloudSkinManagerMessage', error.message || tr('settings.account.textureFailed', 'Не удалось удалить скин.')); }
    });
    $('accountRemoveCape').addEventListener('click', async () => {
      try { await removeSkinTexture('cape'); }
      catch (error) { message('cloudSkinManagerMessage', error.message || tr('settings.account.textureFailed', 'Не удалось удалить плащ.')); }
    });
    $('accountSkinModel').addEventListener('change', async () => {
      try { await saveSkinModel(); }
      catch (error) { message('cloudSkinManagerMessage', error.message || tr('settings.account.modelFailed', 'Не удалось сохранить модель игрока.')); }
    });

    document.querySelectorAll('#accountSkinSystemOptions [data-skin-system]').forEach(button => {
      button.addEventListener('click', async () => {
        const provider = button.dataset.skinSystem;
        document.querySelectorAll('#accountSkinSystemOptions [data-skin-system]').forEach(item => item.classList.toggle('is-active', item === button));
        updateSkinControls(provider);
        try {
          localStorage.setItem('magma_skin_system', provider);
          if (user) await savePreferences({ skin_provider: provider });
          window.dispatchEvent(new CustomEvent('magma:account-settings-updated'));
          if (provider === 'magma') await loadSkinRecord();
          await refreshPreview();
        } catch (error) {
          console.warn('[Magma Account] Could not change skin provider:', error);
        }
      });
    });

    client().auth.onAuthStateChange((_event, session) => {
      user = session?.user || null;
      if (user) refreshAccount().catch(error => { setStatus(tr('settings.account.syncFailed', 'Ошибка синхронизации')); console.error('[Magma Account]', error); });
      else { user = null; requireSignedIn(); }
    });
    await refreshAccount().catch(error => { setStatus(tr('settings.account.syncFailed', 'Ошибка синхронизации')); console.error('[Magma Account]', error); });
    window.addEventListener('focus', () => refreshAccount().catch(console.error));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAccount().catch(console.error); });
  }

  document.addEventListener('DOMContentLoaded', bind);
})();