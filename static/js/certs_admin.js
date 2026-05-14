// static/js/certs_admin.js
//
// Админка раздела «Ключи и сертификаты КриптоПро».
//
// Точка входа: initCryptoCerts() — вызывается из app.js при первом раскрытии
// карточки в ops-аккордеоне (см. OPS_SECTIONS в app.js).
//
// Что делает:
//   • грузит список всех ключей через /api/v1/certs/admin/all и юзеров через
//     /api/v1/admin/users (для селекта владельца);
//   • показывает таблицу с фильтрами по статусу + поиск;
//   • в форме загрузки: webkitdirectory-инпут для папки xxx.000, отдельный
//     инпут для .cer, превью распарсенного сертификата перед сохранением,
//     submit → multipart POST на /admin/upload;
//   • в строке таблицы — меню действий: переназначить, отозвать, удалить.

import { api, ApiError } from './api.js';


const STATE = {
    keys:           [],
    users:          [],
    agents:         [],
    filterStatus:   '',
    searchQuery:    '',
    initialized:    false,
    selectedCerData: null,   // ParsedCertificate из /admin/parse-cer
    selectedContainerFiles: [], // [File, ...]
};


export async function initCryptoCerts() {
    if (STATE.initialized) {
        // Повторное открытие — просто рефрешим таблицы.
        await Promise.all([loadKeys(), loadAgents()]);
        return;
    }
    STATE.initialized = true;

    setupCreateForm();
    setupFilters();

    await Promise.all([loadKeys(), loadUsers(), loadAgents()]);
}


// ─── Загрузка данных ─────────────────────────────────────────────────────────

async function loadKeys() {
    try {
        const params = new URLSearchParams();
        if (STATE.filterStatus) params.set('status_filter', STATE.filterStatus);
        const qs   = params.toString();
        const url  = '/certs/admin/all' + (qs ? `?${qs}` : '');
        const rows = await api.get(url);
        STATE.keys = Array.isArray(rows) ? rows : [];
    } catch (err) {
        console.error('[certs] loadKeys', err);
        STATE.keys = [];
        window.showError?.('Не удалось загрузить список ключей: ' + err.message);
    }
    renderTable();
    updateCountBadge();
}


async function loadAgents() {
    try {
        const rows = await api.get('/certs/admin/agent-tokens');
        STATE.agents = Array.isArray(rows) ? rows : [];
    } catch (err) {
        console.error('[certs] loadAgents', err);
        STATE.agents = [];
    }
    renderAgentsTable();
}


function renderAgentsTable() {
    const tbody = document.getElementById('agents-tbody');
    const badge = document.getElementById('agents-count-badge');
    if (!tbody) return;
    if (badge) badge.textContent = STATE.agents.length;

    if (STATE.agents.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="certs-empty">Никто ещё не установил агента</td></tr>';
        return;
    }

    tbody.innerHTML = STATE.agents.map(a => {
        const machine = a.bound_hostname
            ? `<code class="certs-container-cell">${escapeHtml(a.bound_hostname)}</code>` +
              (a.description ? `<div class="certs-inn">${escapeHtml(a.description)}</div>` : '')
            : `<span class="certs-free">${escapeHtml(a.description || '—')}</span>`;
        const mac = a.bound_mac
            ? `<code>${escapeHtml(formatMac(a.bound_mac))}</code>`
            : '<span class="certs-free">не привязан</span>';
        const lastSeen = a.last_seen_at
            ? `${formatDateTime(a.last_seen_at)}` +
              (a.last_seen_ip ? `<div class="certs-inn">${escapeHtml(a.last_seen_ip)}</div>` : '')
            : '<span class="certs-free">не пинговал</span>';
        const status = a.revoked
            ? `<span class="certs-badge certs-badge--revoked">Отозван</span>` +
              (a.block_reason ? `<div class="certs-inn" title="${escapeHtml(a.block_reason)}">⚠ ${escapeHtml(truncate(a.block_reason, 50))}</div>` : '')
            : `<span class="certs-badge certs-badge--active">Активен</span>`;
        const actions = a.revoked
            ? ''
            : `<button class="btn btn-text btn-xs" data-agent-force="${a.id}" title="Обновить подпись (агент подтянет изменения в течение минуты)">↻</button>
               <button class="btn btn-text btn-xs" data-agent-revoke="${a.id}" title="Отозвать токен (агент перестанет работать сразу)">⊘</button>`;
        return `
            <tr data-agent-id="${a.id}">
                <td>${escapeHtml(a.username)}</td>
                <td>${machine}</td>
                <td>${mac}</td>
                <td>${lastSeen}</td>
                <td>${status}</td>
                <td class="certs-actions">${actions}</td>
            </tr>`;
    }).join('');

    document.querySelectorAll('[data-agent-revoke]').forEach(btn => {
        btn.addEventListener('click', () => handleAgentRevoke(parseInt(btn.dataset.agentRevoke, 10)));
    });
    document.querySelectorAll('[data-agent-force]').forEach(btn => {
        btn.addEventListener('click', () => handleAgentForceSync(parseInt(btn.dataset.agentForce, 10)));
    });
}


async function handleAgentForceSync(id) {
    const a = STATE.agents.find(x => x.id === id);
    if (!a) return;
    try {
        await api.post(`/certs/admin/agent-tokens/${id}/force-sync`, {});
        window.showSnackbar?.(
            `Команда отправлена. Агент «${a.description || a.username}» подтянет изменения в течение минуты.`,
            'success',
        );
        await loadAgents();
    } catch (err) {
        window.showError?.('Не удалось отправить команду: ' + err.message);
    }
}


async function handleAgentRevoke(id) {
    const a = STATE.agents.find(x => x.id === id);
    if (!a) return;
    if (!confirm(`Отозвать токен агента «${a.description || a.username}»?\n\nАгент перестанет работать сразу. Юзеру придётся скачать новый install-пакет.`)) return;
    try {
        await api.post(`/certs/admin/agent-tokens/${id}/revoke`, {});
        window.showSnackbar?.('Токен отозван', 'success');
        await loadAgents();
    } catch (err) {
        window.showError?.('Не удалось отозвать: ' + err.message);
    }
}


function formatMac(raw) {
    if (!raw) return '';
    const hex = raw.replace(/[^0-9A-F]/gi, '').toUpperCase();
    if (hex.length !== 12) return raw;
    return hex.match(/.{2}/g).join(':');
}


function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}


function truncate(s, n) {
    return s.length > n ? s.substring(0, n - 1) + '…' : s;
}


async function loadUsers() {
    try {
        const users = await api.get('/admin/users');
        STATE.users = Array.isArray(users) ? users : [];
    } catch (err) {
        console.error('[certs] loadUsers', err);
        STATE.users = [];
    }
    fillOwnerSelect();
}


// ─── Рендеринг ───────────────────────────────────────────────────────────────

function renderTable() {
    const tbody = document.getElementById('certs-tbody');
    if (!tbody) return;

    const filtered = applyFilters(STATE.keys);

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="certs-empty">Ничего не найдено</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map(rowHtml).join('');
    bindRowActions();
}


function rowHtml(k) {
    const owner = k.owner_username
        ? escapeHtml(k.owner_username)
        : '<span class="certs-free">— свободный —</span>';
    const cn    = escapeHtml(k.subject_cn || '—');
    const inn   = k.subject_inn
        ? `<div class="certs-inn">ИНН: ${escapeHtml(k.subject_inn)}</div>` : '';
    const status = statusBadge(k.status);

    // Цветовая индикация срока — главный визуальный сигнал админу.
    const exp = expiryInfo(k.valid_to);
    const dateCell = `
        <span class="certs-expiry certs-expiry--${exp.kind}">
            ${formatDate(k.valid_to)}
        </span>
        <div class="certs-expiry-hint certs-expiry-hint--${exp.kind}">${exp.label}</div>`;

    return `
        <tr data-key-id="${k.id}" class="certs-row certs-row--${exp.kind}">
            <td><code class="certs-container-cell">${escapeHtml(k.container_name)}</code></td>
            <td>${owner}</td>
            <td>${cn}${inn}</td>
            <td>${dateCell}</td>
            <td>${status}</td>
            <td class="certs-actions">
                <button class="btn btn-text btn-xs" data-act="reassign" title="Переназначить">↻</button>
                <button class="btn btn-text btn-xs" data-act="revoke"   title="Отозвать">⊘</button>
                <button class="btn btn-text btn-xs" data-act="delete"   title="Удалить">🗑</button>
            </td>
        </tr>`;
}


/**
 * Возвращает {kind, label, days} — состояние срока действия.
 *   ok       — > 30 дней
 *   warn     — 14..30 дней
 *   urgent   — 1..14 дней
 *   expired  — <= 0
 */
function expiryInfo(validTo) {
    if (!validTo) return { kind: 'ok', label: '', days: null };
    const now  = new Date();
    const exp  = new Date(validTo);
    const days = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
    if (days <= 0)  return { kind: 'expired', label: 'срок истёк',                  days };
    if (days <= 14) return { kind: 'urgent',  label: `осталось ${days} дн.`,        days };
    if (days <= 30) return { kind: 'warn',    label: `истекает через ${days} дн.`,  days };
    return                  { kind: 'ok',     label: `${days} дн. до истечения`,    days };
}


function statusBadge(status) {
    const map = {
        active:  { cls: 'certs-badge--active',  text: 'Активн.' },
        revoked: { cls: 'certs-badge--revoked', text: 'Отозван' },
        expired: { cls: 'certs-badge--expired', text: 'Истёк'   },
    };
    const m = map[status] || { cls: '', text: status };
    return `<span class="certs-badge ${m.cls}">${m.text}</span>`;
}


function updateCountBadge() {
    const el = document.getElementById('certs-count-badge');
    if (!el) return;

    const total   = STATE.keys.length;
    const expired = STATE.keys.filter(k => expiryInfo(k.valid_to).kind === 'expired').length;
    const urgent  = STATE.keys.filter(k => expiryInfo(k.valid_to).kind === 'urgent' ).length;
    const warn    = STATE.keys.filter(k => expiryInfo(k.valid_to).kind === 'warn'   ).length;

    // Сегменты показываем только если есть что — иначе просто число.
    const parts = [`всего: ${total}`];
    if (urgent)  parts.push(`🔴 срочно: ${urgent}`);
    if (warn)    parts.push(`🟡 скоро: ${warn}`);
    if (expired) parts.push(`⚫ истёк: ${expired}`);

    el.textContent = parts.join(' · ');
    el.title = 'срочно — до 14 дн., скоро — до 30 дн., истёк — нужно отозвать или загрузить новый';
}


function fillOwnerSelect() {
    const sel = document.getElementById('certs-owner');
    if (!sel) return;
    const opts = ['<option value="">— оставить свободным (назначу позже) —</option>'];
    for (const u of STATE.users) {
        // role!=admin — админам не назначаем (они и так всё видят).
        if (u.role === 'admin') continue;
        opts.push(`<option value="${u.id}">${escapeHtml(u.username)}</option>`);
    }
    sel.innerHTML = opts.join('');
}


// ─── Фильтры ─────────────────────────────────────────────────────────────────

function setupFilters() {
    const statusSel = document.getElementById('certs-filter-status');
    const search    = document.getElementById('certs-search');

    statusSel?.addEventListener('change', async () => {
        STATE.filterStatus = statusSel.value;
        await loadKeys();   // фильтр статуса — на сервере
    });

    search?.addEventListener('input', () => {
        STATE.searchQuery = (search.value || '').trim().toLowerCase();
        renderTable();      // поиск — на клиенте (по уже загруженным)
    });
}


function applyFilters(keys) {
    const q = STATE.searchQuery;
    if (!q) return keys;
    return keys.filter(k => {
        const hay = [
            k.container_name, k.owner_username,
            k.subject_cn, k.subject_o, k.subject_inn, k.subject_snils,
            k.thumbprint, k.issuer_cn,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
    });
}


// ─── Форма создания ──────────────────────────────────────────────────────────

function setupCreateForm() {
    const toggleBtn    = document.getElementById('certs-toggle-create');
    const form         = document.getElementById('certs-create-form');
    const cancelBtn    = document.getElementById('certs-cancel-btn');
    const submitBtn    = document.getElementById('certs-submit-btn');
    const containerIn  = document.getElementById('certs-container-input');
    const containerNm  = document.getElementById('certs-container-name');
    const cerIn        = document.getElementById('certs-cer-input');

    toggleBtn?.addEventListener('click', () => {
        form.classList.toggle('hidden');
        if (!form.classList.contains('hidden')) resetForm();
    });
    cancelBtn?.addEventListener('click', () => {
        form.classList.add('hidden');
        resetForm();
    });

    containerIn?.addEventListener('change', () => handleContainerSelect(containerIn));
    cerIn?.addEventListener('change',       () => handleCerSelect(cerIn));
    submitBtn?.addEventListener('click',    () => submitNewKey());
}


function resetForm() {
    STATE.selectedCerData        = null;
    STATE.selectedContainerFiles = [];

    document.getElementById('certs-container-input').value     = '';
    document.getElementById('certs-container-name').value      = '';
    document.getElementById('certs-cer-input').value           = '';
    document.getElementById('certs-owner').value               = '';
    document.getElementById('certs-note').value                = '';

    const filesEl = document.getElementById('certs-container-files');
    filesEl?.classList.add('hidden');
    if (filesEl) filesEl.innerHTML = '';

    const cerPrev = document.getElementById('certs-cer-preview');
    cerPrev?.classList.add('hidden');
    if (cerPrev) cerPrev.innerHTML = '';

    updateSubmitState();
}


// Имена файлов, которые мы реально кладём в контейнер. Остальные (например
// служебные .DS_Store) молча отфильтровываем.
const ALLOWED_CONTAINER_FILES = new Set([
    'header.key', 'masks.key', 'masks2.key',
    'name.key', 'primary.key', 'primary2.key',
]);


function handleContainerSelect(input) {
    const all = Array.from(input.files || []);
    // webkitRelativePath = "buh_2026.000/header.key" — используем его если есть.
    // basename без пути нам всегда даёт чистое имя файла.
    const filtered = [];
    let folderName = null;
    for (const f of all) {
        const rel  = (f.webkitRelativePath || '').replaceAll('\\', '/');
        const name = (rel ? rel.split('/').pop() : f.name).toLowerCase();
        if (!ALLOWED_CONTAINER_FILES.has(name)) continue;
        filtered.push(f);
        if (!folderName && rel) {
            const folder = rel.split('/').slice(0, -1).pop();
            if (folder) folderName = folder.replace(/\.\d{3}$/, '');
        }
    }
    STATE.selectedContainerFiles = filtered;

    // Авто-имя контейнера, если поле ещё пустое.
    const nameField = document.getElementById('certs-container-name');
    if (folderName && nameField && !nameField.value) {
        nameField.value = folderName;
    }

    const filesEl = document.getElementById('certs-container-files');
    if (filesEl) {
        if (filtered.length === 0) {
            filesEl.classList.remove('hidden');
            filesEl.innerHTML =
                '<div class="certs-files-warn">Ни один файл не распознан как часть контейнера КриптоПро.</div>';
        } else {
            const total = filtered.reduce((s, f) => s + f.size, 0);
            const rows  = filtered.map(f => `
                <li><code>${escapeHtml(f.name)}</code> <span>${fmtSize(f.size)}</span></li>
            `).join('');
            filesEl.classList.remove('hidden');
            filesEl.innerHTML = `
                <div class="certs-files-ok">
                    Файлов: <b>${filtered.length}</b>, общий размер: <b>${fmtSize(total)}</b>
                </div>
                <ul class="certs-files-ul">${rows}</ul>`;
        }
    }
    updateSubmitState();
}


async function handleCerSelect(input) {
    const file = (input.files || [])[0];
    const prev = document.getElementById('certs-cer-preview');
    STATE.selectedCerData = null;
    if (!file) {
        prev?.classList.add('hidden');
        if (prev) prev.innerHTML = '';
        updateSubmitState();
        return;
    }

    // Превью: POST /admin/parse-cer.
    const fd = new FormData();
    fd.append('cert', file);

    try {
        prev?.classList.remove('hidden');
        if (prev) prev.innerHTML = '<div class="certs-cer-loading">Разбираем сертификат…</div>';

        const data = await api.upload('/certs/admin/parse-cer', fd);
        STATE.selectedCerData = data;

        const warn = data.already_exists
            ? `<div class="certs-cer-warn">⚠ Такой ключ уже загружен${
                data.existing_owner ? ' (владелец: ' + escapeHtml(data.existing_owner) + ')' : ''
              }. Загрузить повторно нельзя.</div>`
            : '';

        if (prev) prev.innerHTML = `
            ${warn}
            <table class="certs-cer-grid">
                <tr><td>Владелец:</td><td>${escapeHtml(data.subject_cn || '—')}</td></tr>
                <tr><td>Организация:</td><td>${escapeHtml(data.subject_o || '—')}</td></tr>
                <tr><td>ИНН:</td><td>${escapeHtml(data.subject_inn || '—')}</td></tr>
                <tr><td>СНИЛС:</td><td>${escapeHtml(data.subject_snils || '—')}</td></tr>
                <tr><td>Издатель:</td><td>${escapeHtml(data.issuer_cn || '—')}</td></tr>
                <tr><td>Срок:</td><td>${formatDate(data.valid_from)} — ${formatDate(data.valid_to)}</td></tr>
                <tr><td>Отпечаток:</td><td><code>${escapeHtml(data.thumbprint)}</code></td></tr>
                <tr><td>Алгоритм:</td><td>${escapeHtml(data.algorithm)}</td></tr>
            </table>`;
    } catch (err) {
        STATE.selectedCerData = null;
        if (prev) prev.innerHTML =
            `<div class="certs-cer-error">Ошибка: ${escapeHtml(err.message)}</div>`;
    }
    updateSubmitState();
}


function updateSubmitState() {
    const btn = document.getElementById('certs-submit-btn');
    if (!btn) return;
    const okCer       = STATE.selectedCerData && !STATE.selectedCerData.already_exists;
    const okContainer = STATE.selectedContainerFiles.length >= 4;   // мин. набор
    const okName      = (document.getElementById('certs-container-name')?.value || '').trim().length > 0;
    btn.disabled = !(okCer && okContainer && okName);
}


async function submitNewKey() {
    const submitBtn   = document.getElementById('certs-submit-btn');
    const containerNm = document.getElementById('certs-container-name')?.value || '';
    const ownerId     = document.getElementById('certs-owner')?.value || '';
    const note        = document.getElementById('certs-note')?.value || '';

    if (!STATE.selectedCerData || STATE.selectedContainerFiles.length === 0) {
        window.showError?.('Не все обязательные поля заполнены');
        return;
    }

    const fd = new FormData();
    fd.append('cert', document.getElementById('certs-cer-input').files[0]);
    for (const f of STATE.selectedContainerFiles) {
        // Имя в FormData = basename без пути, чтобы сервер видел только "header.key".
        fd.append('container', f, f.name.toLowerCase());
    }
    fd.append('container_name', containerNm);
    if (ownerId) fd.append('owner_user_id', ownerId);
    if (note)    fd.append('note',          note);

    submitBtn.disabled = true;
    try {
        await api.upload('/certs/admin/upload', fd);
        window.showSnackbar?.('Ключ загружен в Vault', 'success');
        document.getElementById('certs-create-form').classList.add('hidden');
        resetForm();
        await loadKeys();
    } catch (err) {
        const msg = (err instanceof ApiError) ? err.message : String(err);
        window.showError?.('Не удалось загрузить ключ: ' + msg);
    } finally {
        submitBtn.disabled = false;
    }
}


// ─── Действия в таблице ──────────────────────────────────────────────────────

function bindRowActions() {
    document.querySelectorAll('#certs-tbody tr[data-key-id]').forEach(tr => {
        const id  = parseInt(tr.dataset.keyId, 10);
        const key = STATE.keys.find(k => k.id === id);
        if (!key) return;

        tr.querySelector('[data-act="reassign"]')?.addEventListener('click', () => handleReassign(key));
        tr.querySelector('[data-act="revoke"]')  ?.addEventListener('click', () => handleRevoke(key));
        tr.querySelector('[data-act="delete"]')  ?.addEventListener('click', () => handleDelete(key));
    });
}


async function handleReassign(key) {
    const list = STATE.users
        .filter(u => u.role !== 'admin')
        .map(u => `${u.id} = ${u.username}`)
        .join('\n');
    const input = prompt(
        `Переназначить ключ «${key.container_name}»\n\n` +
        `Введите ID пользователя из списка (или 0 чтобы снять владельца):\n\n${list}`,
        key.owner_user_id || '',
    );
    if (input === null) return;
    const ownerId = parseInt(input, 10);
    if (isNaN(ownerId)) {
        window.showError?.('Неверный ID');
        return;
    }
    try {
        await api.patch(`/certs/admin/${key.id}`, { owner_user_id: ownerId });
        window.showSnackbar?.('Владелец обновлён', 'success');
        await loadKeys();
    } catch (err) {
        window.showError?.('Не удалось переназначить: ' + err.message);
    }
}


async function handleRevoke(key) {
    if (!confirm(`Отозвать ключ «${key.container_name}»? Все агенты при следующей синхронизации удалят его с клиентских машин.`)) {
        return;
    }
    try {
        await api.patch(`/certs/admin/${key.id}`, { status: 'revoked' });
        window.showSnackbar?.('Ключ отозван', 'success');
        await loadKeys();
    } catch (err) {
        window.showError?.('Не удалось отозвать: ' + err.message);
    }
}


async function handleDelete(key) {
    if (!confirm(`УДАЛИТЬ полностью ключ «${key.container_name}» из Vault и БД?\n\nЭто действие необратимо.`)) {
        return;
    }
    try {
        await api.delete(`/certs/admin/${key.id}`);
        window.showSnackbar?.('Ключ удалён', 'success');
        await loadKeys();
    } catch (err) {
        window.showError?.('Не удалось удалить: ' + err.message);
    }
}


// ─── Утилиты ────────────────────────────────────────────────────────────────

function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}


function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
    return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
}


function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
