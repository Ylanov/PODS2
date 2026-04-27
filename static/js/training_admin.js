// static/js/training_admin.js
//
// Админ-панель отдела проф. подготовки. Открывается из «Операций»
// для пользователей со специальным username (см. TRAINING_USERNAMES).
//
// Состоит из:
//   • Раздел «Темы тестирования» — CRUD тем
//   • Раздел «Ссылки на тесты» — генерация и просмотр персональных ссылок
//   • Модалка с QR-кодом + URL для распечатки/отправки
//
// Полные тесты (вопросы, прохождение) — отдельный модуль, реализуем
// позже. Сейчас фокус на регистрации участников по QR-коду.

import { api } from './api.js';
import { attach as attachFio } from './fio_autocomplete.js';

// Список username'ов, у которых должна быть кнопка «Проф. подготовка»
// в Операциях. Должен совпадать с TRAINING_UNIT_USERNAMES в .env бэкенда.
// В будущем можно вынести в /auth/me, пока — захардкоден дефолт.
export const TRAINING_USERNAMES = ['proftraining'];

const STATUS_LABELS = {
    created:     'Ссылка создана',
    registered:  'Анкета заполнена',
    in_progress: 'Тест идёт',
    completed:   'Завершён',
    expired:     'Отозвана',
};


function esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtDateTime(d) {
    if (!d) return '—';
    const dt = new Date(d);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(dt.getDate())}.${pad(dt.getMonth() + 1)}.${dt.getFullYear()} ` +
           `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}


// ─── Состояние модуля ───────────────────────────────────────────────────────

const _state = {
    overlay:  null,
    topics:   [],
    attempts: [],
    filters:  { status: '', topic_id: '' },
};


export async function openTraining() {
    _renderShell();
    await Promise.all([_reloadTopics(), _reloadAttempts()]);
}


function _close() {
    _state.overlay?.remove();
    _state.overlay = null;
    document.removeEventListener('keydown', _onEsc);
}
function _onEsc(e) { if (e.key === 'Escape') _close(); }


function _renderShell() {
    document.getElementById('training-overlay')?.remove();

    const ov = document.createElement('div');
    ov.id = 'training-overlay';
    ov.className = 'tr-overlay';
    ov.innerHTML = `
        <div class="tr-dialog" role="dialog" aria-label="Проф. подготовка">
            <div class="tr-header">
                <div class="tr-header__titles">
                    <div class="tr-header__title">Профессиональная подготовка</div>
                    <div class="tr-header__subtitle">
                        Темы тестирования, генерация QR-кодов и ссылок,
                        просмотр входящих заявок.
                    </div>
                </div>
                <div class="tr-header__actions">
                    <button class="btn btn-outlined btn-sm" id="tr-summary" type="button"
                            title="Сводный отчёт по всем тестам с разрезом по подразделениям и темам">
                        📈 Сводный отчёт
                    </button>
                    <button class="btn btn-text btn-sm" id="tr-close" type="button">Закрыть</button>
                </div>
            </div>
            <div class="tr-body">
                <!-- ── Темы ───────────────────────────────────────────── -->
                <section class="tr-section">
                    <div class="tr-section__head">
                        <h3 class="tr-section__title">Темы тестирования</h3>
                        <button class="btn btn-outlined btn-sm" id="tr-add-topic" type="button">
                            + Тема
                        </button>
                    </div>
                    <div class="tr-topics" id="tr-topics">
                        <div class="tr-loading">Загрузка тем…</div>
                    </div>
                </section>

                <!-- ── Ссылки/попытки ─────────────────────────────────── -->
                <section class="tr-section">
                    <div class="tr-section__head">
                        <h3 class="tr-section__title">Ссылки на тесты</h3>
                        <div class="tr-toolbar">
                            <select id="tr-filter-status">
                                <option value="">Все статусы</option>
                                ${Object.entries(STATUS_LABELS).map(
                                    ([k, v]) => `<option value="${k}">${esc(v)}</option>`
                                ).join('')}
                            </select>
                            <select id="tr-filter-topic">
                                <option value="">Все темы</option>
                            </select>
                            <button class="btn btn-outlined btn-sm" id="tr-add-person-attempt" type="button"
                                    title="Создать нового человека в общей базе и сразу выдать ему ссылку">
                                + Новый человек
                            </button>
                            <button class="btn btn-outlined btn-sm" id="tr-add-attempt-all" type="button"
                                    title="Сгенерировать ссылки для всей активной базы людей">
                                🌐 Всем сразу
                            </button>
                            <button class="btn btn-filled btn-sm" id="tr-add-attempt" type="button">
                                + Ссылка
                            </button>
                        </div>
                    </div>
                    <div class="tr-attempts" id="tr-attempts">
                        <div class="tr-loading">Загрузка ссылок…</div>
                    </div>
                </section>
            </div>
        </div>
    `;
    document.body.appendChild(ov);
    _state.overlay = ov;

    ov.addEventListener('click', e => { if (e.target === ov) _close(); });
    document.addEventListener('keydown', _onEsc);
    ov.querySelector('#tr-close').addEventListener('click', _close);
    ov.querySelector('#tr-summary').addEventListener('click', _openSummaryReport);

    ov.querySelector('#tr-add-topic').addEventListener('click', () => _openTopicForm(null));
    ov.querySelector('#tr-add-attempt').addEventListener('click', _openAttemptForm);
    ov.querySelector('#tr-add-attempt-all').addEventListener('click', _openAttemptAllForm);
    ov.querySelector('#tr-add-person-attempt').addEventListener('click', _openPersonAttemptForm);

    ov.querySelector('#tr-filter-status').addEventListener('change', (e) => {
        _state.filters.status = e.target.value; _reloadAttempts();
    });
    ov.querySelector('#tr-filter-topic').addEventListener('change', (e) => {
        _state.filters.topic_id = e.target.value; _reloadAttempts();
    });
}


// ─── Темы ───────────────────────────────────────────────────────────────────

async function _reloadTopics() {
    try {
        _state.topics = await api.get('/training/topics');
        _renderTopics();
        _renderTopicFilterOptions();
    } catch (err) {
        console.error('[training] topics:', err);
        const el = document.getElementById('tr-topics');
        if (el) el.innerHTML = `<div class="tr-error">Ошибка: ${esc(err.message || '')}</div>`;
    }
}


function _renderTopics() {
    const el = document.getElementById('tr-topics');
    if (!el) return;
    if (!_state.topics.length) {
        el.innerHTML = `
            <div class="tr-empty">
                Темы не созданы. Нажмите «+ Тема», чтобы добавить первую.
            </div>`;
        return;
    }
    el.innerHTML = `
        <div class="tr-topic-grid">
            ${_state.topics.map(t => {
                const qCount = t.question_count || 0;
                const wordVopr = qCount === 1 ? 'вопрос'
                              : qCount < 5    ? 'вопроса' : 'вопросов';
                return `
                <div class="tr-topic-card ${t.is_active === 'N' ? 'tr-topic-card--inactive' : ''}"
                     data-id="${t.id}">
                    <div class="tr-topic-card__head">
                        <div class="tr-topic-card__name">${esc(t.name)}</div>
                        <div class="tr-topic-card__actions">
                            <button class="btn btn-outlined btn-sm" data-act="questions" data-id="${t.id}"
                                    title="Управление вопросами">📝 Вопросы</button>
                            <button class="btn btn-text btn-sm" data-act="edit" data-id="${t.id}">✎</button>
                            <button class="btn btn-text btn-sm" data-act="del"  data-id="${t.id}">✕</button>
                        </div>
                    </div>
                    ${t.description ? `
                        <div class="tr-topic-card__desc">${esc(t.description)}</div>
                    ` : ''}
                    <div class="tr-topic-card__meta">
                        <span><b>${qCount}</b> ${wordVopr}</span>
                        ${t.duration_minutes ? `<span>${t.duration_minutes} мин</span>` : ''}
                        ${t.pass_threshold   ? `<span>проходной ${t.pass_threshold}%</span>` : ''}
                        ${t.is_active === 'N' ? `<span class="tr-topic-card__off">отключена</span>` : ''}
                    </div>
                </div>`;
            }).join('')}
        </div>
    `;

    el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = parseInt(btn.dataset.id, 10);
        const t  = _state.topics.find(x => x.id === id);
        if (!t) return;
        if      (btn.dataset.act === 'questions') _openQuestionsEditor(t);
        else if (btn.dataset.act === 'edit')      _openTopicForm(t);
        else if (btn.dataset.act === 'del')       _deleteTopic(t);
    });
}


function _renderTopicFilterOptions() {
    const sel = document.getElementById('tr-filter-topic');
    if (!sel) return;
    const current = _state.filters.topic_id;
    sel.innerHTML = `
        <option value="">Все темы</option>
        ${_state.topics.map(t =>
            `<option value="${t.id}" ${String(t.id) === current ? 'selected' : ''}>${esc(t.name)}</option>`
        ).join('')}
    `;
}


function _openTopicForm(topic) {
    document.getElementById('tr-topic-modal')?.remove();

    const isEdit = !!topic;
    const data = topic || {
        name: '', description: '',
        pass_threshold: '', duration_minutes: '',
        is_active: 'Y',
    };

    const m = document.createElement('div');
    m.id = 'tr-topic-modal';
    m.className = 'tr-form-modal';
    m.innerHTML = `
        <div class="tr-form" role="dialog">
            <div class="tr-form__head">
                <span class="tr-form__title">${isEdit ? 'Редактировать тему' : 'Новая тема'}</span>
                <button class="btn btn-text btn-sm" data-tr-close type="button">✕</button>
            </div>
            <div class="tr-form__body">
                <label class="tr-field tr-field--full">
                    <span class="tr-field__label">Название *</span>
                    <input type="text" data-f="name" maxlength="200"
                           value="${esc(data.name)}" required>
                </label>
                <label class="tr-field tr-field--full">
                    <span class="tr-field__label">Описание</span>
                    <textarea data-f="description" rows="3">${esc(data.description || '')}</textarea>
                </label>
                <label class="tr-field">
                    <span class="tr-field__label">Длительность, мин</span>
                    <input type="number" data-f="duration_minutes" min="0" max="600"
                           value="${data.duration_minutes ?? ''}">
                </label>
                <label class="tr-field">
                    <span class="tr-field__label">Проходной балл, %</span>
                    <input type="number" data-f="pass_threshold" min="0" max="100"
                           value="${data.pass_threshold ?? ''}">
                </label>
                <label class="tr-field">
                    <span class="tr-field__label">Статус</span>
                    <select data-f="is_active">
                        <option value="Y" ${data.is_active === 'Y' ? 'selected' : ''}>Активна</option>
                        <option value="N" ${data.is_active === 'N' ? 'selected' : ''}>Отключена</option>
                    </select>
                </label>
                ${isEdit ? `
                    <div class="tr-field tr-field--full">
                        <span class="tr-field__hint">
                            Количество вопросов считается автоматически из созданных
                            (сейчас: ${data.question_count || 0}).
                        </span>
                    </div>
                ` : ''}
            </div>
            <div class="tr-form__foot">
                <button class="btn btn-text btn-sm"     data-tr-close type="button">Отмена</button>
                <button class="btn btn-filled btn-sm"   data-tr-save  type="button">Сохранить</button>
            </div>
        </div>
    `;
    _state.overlay.appendChild(m);

    m.querySelectorAll('[data-tr-close]').forEach(b =>
        b.addEventListener('click', () => m.remove())
    );
    m.querySelector('[data-tr-save]').addEventListener('click', async () => {
        const payload = {};
        m.querySelectorAll('[data-f]').forEach(el => {
            const v = el.value.trim();
            const k = el.dataset.f;
            if (['pass_threshold', 'duration_minutes'].includes(k)) {
                payload[k] = v === '' ? null : parseInt(v, 10);
            } else if (k === 'description') {
                payload[k] = v || null;
            } else {
                payload[k] = v;
            }
        });
        if (!payload.name) {
            window.showSnackbar?.('Название обязательно', 'error'); return;
        }
        try {
            if (isEdit) await api.put(`/training/topics/${topic.id}`, payload);
            else        await api.post('/training/topics', payload);
            window.showSnackbar?.(isEdit ? 'Тема обновлена' : 'Тема создана', 'success');
            m.remove();
            await _reloadTopics();
        } catch (err) {
            window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
        }
    });
}


async function _deleteTopic(topic) {
    if (!window.confirm(`Удалить тему «${topic.name}»? Действие необратимо.`)) return;
    try {
        await api.delete(`/training/topics/${topic.id}`);
        window.showSnackbar?.('Тема удалена', 'success');
        await _reloadTopics();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
    }
}


// ─── Редактор вопросов ─────────────────────────────────────────────────────

async function _openQuestionsEditor(topic) {
    document.getElementById('tr-questions-modal')?.remove();

    const m = document.createElement('div');
    m.id = 'tr-questions-modal';
    m.className = 'tr-form-modal';
    m.innerHTML = `
        <div class="tr-form tr-questions" role="dialog" style="width: min(880px, 100%); max-height: 92%;">
            <div class="tr-form__head">
                <div>
                    <span class="tr-form__title">Вопросы темы «${esc(topic.name)}»</span>
                    <div class="tr-questions__sub" id="tr-questions-sub">Загрузка…</div>
                </div>
                <button class="btn btn-text btn-sm" data-tr-close type="button">✕</button>
            </div>
            <div class="tr-form__body" style="grid-template-columns:none; padding: 14px 18px;">
                <div class="tr-questions__list" id="tr-questions-list"></div>
            </div>
            <div class="tr-form__foot">
                <button class="btn btn-outlined btn-sm" id="tr-q-add" type="button">+ Вопрос</button>
                <div style="flex:1"></div>
                <button class="btn btn-filled btn-sm"   data-tr-close type="button">Готово</button>
            </div>
        </div>
    `;
    _state.overlay.appendChild(m);
    m.querySelectorAll('[data-tr-close]').forEach(b =>
        b.addEventListener('click', async () => {
            m.remove();
            await _reloadTopics();   // обновим question_count в карточках
        })
    );

    let questions = [];
    async function reload() {
        try {
            questions = await api.get(`/training/topics/${topic.id}/questions`);
            render();
        } catch (err) {
            m.querySelector('#tr-questions-list').innerHTML =
                `<div class="tr-error">Ошибка: ${esc(err.message || '')}</div>`;
        }
    }

    function render() {
        const sub = m.querySelector('#tr-questions-sub');
        const cnt = questions.length;
        const word = cnt === 1 ? 'вопрос' : cnt < 5 ? 'вопроса' : 'вопросов';
        sub.textContent = `${cnt} ${word}`;

        const list = m.querySelector('#tr-questions-list');
        if (!questions.length) {
            list.innerHTML = `
                <div class="tr-empty">
                    Вопросов нет. Нажмите «+ Вопрос», чтобы добавить первый.
                </div>`;
            return;
        }
        list.innerHTML = questions.map((q, i) => `
            <div class="tr-q-card" data-id="${q.id}">
                <div class="tr-q-card__head">
                    <span class="tr-q-card__num">№ ${i + 1}</span>
                    <span class="tr-q-card__text">${esc(q.text)}</span>
                    <div class="tr-q-card__actions">
                        <button class="btn btn-text btn-sm" data-q-act="edit" data-id="${q.id}">✎</button>
                        <button class="btn btn-text btn-sm" data-q-act="del"  data-id="${q.id}">✕</button>
                    </div>
                </div>
                <ul class="tr-q-card__opts">
                    ${(q.options || []).map(o => `
                        <li class="${o.correct ? 'tr-q-opt--correct' : ''}">
                            ${o.correct ? '✓' : '○'} ${esc(o.text)}
                        </li>
                    `).join('')}
                </ul>
            </div>
        `).join('');

        list.querySelectorAll('[data-q-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.id, 10);
                const q = questions.find(x => x.id === id);
                if (!q) return;
                if (btn.dataset.qAct === 'edit') _openQuestionForm(topic, q, reload);
                else if (btn.dataset.qAct === 'del') _deleteQuestion(q, reload);
            });
        });
    }

    m.querySelector('#tr-q-add').addEventListener('click', () =>
        _openQuestionForm(topic, null, reload)
    );

    await reload();
}


function _openQuestionForm(topic, question, onSaved) {
    document.getElementById('tr-q-form')?.remove();

    const isEdit = !!question;
    const data = question || { text: '', options: [
        { text: '', correct: false },
        { text: '', correct: false },
    ], points: 1 };

    const m = document.createElement('div');
    m.id = 'tr-q-form';
    m.className = 'tr-form-modal';
    m.innerHTML = `
        <div class="tr-form" role="dialog" style="width: min(720px, 100%);">
            <div class="tr-form__head">
                <span class="tr-form__title">
                    ${isEdit ? 'Редактировать вопрос' : 'Новый вопрос'}
                </span>
                <button class="btn btn-text btn-sm" data-tr-close type="button">✕</button>
            </div>
            <div class="tr-form__body" style="grid-template-columns:none; padding: 14px 18px;">
                <label class="tr-field tr-field--full">
                    <span class="tr-field__label">Текст вопроса *</span>
                    <textarea id="tr-q-text" rows="2" maxlength="2000"
                              required>${esc(data.text)}</textarea>
                </label>
                <div class="tr-field tr-field--full">
                    <span class="tr-field__label">
                        Варианты ответов (отметьте правильный) *
                    </span>
                    <div class="tr-q-opts" id="tr-q-opts"></div>
                    <button type="button" class="btn btn-text btn-sm" id="tr-q-add-opt"
                            style="align-self: flex-start; margin-top: 4px;">
                        + Вариант
                    </button>
                </div>
                <label class="tr-field" style="max-width: 200px;">
                    <span class="tr-field__label">Балл за вопрос</span>
                    <input type="number" id="tr-q-points" min="0" max="100"
                           value="${data.points ?? 1}">
                </label>
            </div>
            <div class="tr-form__foot">
                <button class="btn btn-text btn-sm"     data-tr-close type="button">Отмена</button>
                <button class="btn btn-filled btn-sm"   data-tr-save  type="button">Сохранить</button>
            </div>
        </div>
    `;
    _state.overlay.appendChild(m);

    const optsEl = m.querySelector('#tr-q-opts');
    const renderOpts = (opts) => {
        optsEl.innerHTML = opts.map((o, i) => `
            <div class="tr-q-opt-row" data-idx="${i}">
                <input type="checkbox" class="tr-q-opt-correct"
                       ${o.correct ? 'checked' : ''}
                       title="Правильный ответ">
                <input type="text" class="tr-q-opt-text" maxlength="1000"
                       value="${esc(o.text)}" placeholder="Текст варианта">
                <button type="button" class="btn btn-text btn-sm tr-q-opt-del"
                        title="Удалить вариант">✕</button>
            </div>
        `).join('');
    };
    let opts = JSON.parse(JSON.stringify(data.options || []));
    if (opts.length < 2) opts = [{text:'',correct:false},{text:'',correct:false}];
    renderOpts(opts);

    optsEl.addEventListener('click', (e) => {
        const del = e.target.closest('.tr-q-opt-del');
        if (!del) return;
        const row = del.closest('.tr-q-opt-row');
        const idx = parseInt(row.dataset.idx, 10);
        // Сохраним текущее состояние перед удалением
        const current = collectOpts();
        current.splice(idx, 1);
        if (current.length < 2) current.push({text:'',correct:false});
        renderOpts(current);
    });

    m.querySelector('#tr-q-add-opt').addEventListener('click', () => {
        const current = collectOpts();
        current.push({text:'',correct:false});
        if (current.length > 8) {
            window.showSnackbar?.('Максимум 8 вариантов', 'error');
            return;
        }
        renderOpts(current);
    });

    function collectOpts() {
        const rows = optsEl.querySelectorAll('.tr-q-opt-row');
        return Array.from(rows).map(r => ({
            text:    r.querySelector('.tr-q-opt-text').value,
            correct: r.querySelector('.tr-q-opt-correct').checked,
        }));
    }

    m.querySelectorAll('[data-tr-close]').forEach(b =>
        b.addEventListener('click', () => m.remove())
    );
    m.querySelector('[data-tr-save]').addEventListener('click', async () => {
        const text = m.querySelector('#tr-q-text').value.trim();
        if (!text) {
            window.showSnackbar?.('Введите текст вопроса', 'error');
            return;
        }
        const collected = collectOpts()
            .map(o => ({ text: o.text.trim(), correct: !!o.correct }))
            .filter(o => o.text);
        if (collected.length < 2) {
            window.showSnackbar?.('Нужно минимум 2 варианта', 'error');
            return;
        }
        if (!collected.some(o => o.correct)) {
            window.showSnackbar?.('Отметьте хотя бы один правильный вариант', 'error');
            return;
        }
        const points = parseInt(m.querySelector('#tr-q-points').value, 10) || 1;

        const payload = { text, options: collected, points, order_index: question?.order_index ?? 0 };
        try {
            if (isEdit) await api.put(`/training/questions/${question.id}`, payload);
            else        await api.post(`/training/topics/${topic.id}/questions`, payload);
            window.showSnackbar?.(isEdit ? 'Вопрос обновлён' : 'Вопрос добавлен', 'success');
            m.remove();
            await onSaved?.();
        } catch (err) {
            window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
        }
    });
}


async function _deleteQuestion(question, onDeleted) {
    if (!window.confirm('Удалить этот вопрос?')) return;
    try {
        await api.delete(`/training/questions/${question.id}`);
        window.showSnackbar?.('Вопрос удалён', 'success');
        await onDeleted?.();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
    }
}


// ─── Ссылки/попытки ─────────────────────────────────────────────────────────

async function _reloadAttempts() {
    const params = new URLSearchParams();
    if (_state.filters.status)   params.set('status',   _state.filters.status);
    if (_state.filters.topic_id) params.set('topic_id', _state.filters.topic_id);
    try {
        const res = await api.get(`/training/attempts?${params.toString()}`);
        _state.attempts = res.items || [];
        _renderAttempts();
    } catch (err) {
        const el = document.getElementById('tr-attempts');
        if (el) el.innerHTML = `<div class="tr-error">Ошибка: ${esc(err.message || '')}</div>`;
    }
}


function _renderAttempts() {
    const el = document.getElementById('tr-attempts');
    if (!el) return;
    if (!_state.attempts.length) {
        el.innerHTML = `
            <div class="tr-empty">
                Ссылок пока нет. Нажмите «+ Сгенерировать ссылку», чтобы создать
                персональный QR для конкретного человека из общей базы.
            </div>`;
        return;
    }
    el.innerHTML = `
        <table class="tr-table">
            <thead>
                <tr>
                    <th>ФИО</th>
                    <th>Темы</th>
                    <th>Статус</th>
                    <th>Заполнил</th>
                    <th>Создан</th>
                    <th style="width:160px;"></th>
                </tr>
            </thead>
            <tbody>
                ${_state.attempts.map(a => {
                    const names = Array.isArray(a.topic_names) && a.topic_names.length
                        ? a.topic_names : [];
                    const topicHtml = names.length === 0
                        ? '—'
                        : names.map(n => `<span class="tr-topic-pill">${esc(n)}</span>`).join(' ');
                    return `
                    <tr data-id="${a.id}">
                        <td class="tr-cell-fio">
                            ${esc(a.person_full_name || '—')}
                            ${a.form_department ? `<div class="tr-cell-sub">${esc(a.form_department)}</div>` : ''}
                            ${a.form_phone      ? `<div class="tr-cell-sub">${esc(a.form_phone)}</div>` : ''}
                        </td>
                        <td class="tr-cell-topics">${topicHtml}</td>
                        <td>
                            <span class="tr-status tr-status--${a.status}">
                                ${esc(STATUS_LABELS[a.status] || a.status)}
                            </span>
                        </td>
                        <td class="tr-cell-meta">${fmtDateTime(a.registered_at)}</td>
                        <td class="tr-cell-meta">${fmtDateTime(a.created_at)}</td>
                        <td class="tr-cell-actions">
                            ${(a.status === 'completed' || a.status === 'in_progress')
                                ? `<button class="btn btn-outlined btn-sm" data-act="report" data-id="${a.id}"
                                          title="Отчёт по результатам теста">📊</button>`
                                : ''}
                            <button class="btn btn-outlined btn-sm" data-act="qr"     data-id="${a.id}">QR</button>
                            <button class="btn btn-text     btn-sm" data-act="copy"   data-id="${a.id}" data-url="${esc(a.url)}">⎘</button>
                            ${a.status !== 'expired' ? `
                                <button class="btn btn-text btn-sm tr-act--danger"
                                        data-act="revoke" data-id="${a.id}">×</button>
                            ` : ''}
                        </td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
    `;

    el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = parseInt(btn.dataset.id, 10);
        const a  = _state.attempts.find(x => x.id === id);
        if (!a) return;
        if      (btn.dataset.act === 'qr')      _showQrModal(a);
        else if (btn.dataset.act === 'copy')    _copyUrl(btn.dataset.url);
        else if (btn.dataset.act === 'revoke')  _revokeAttempt(a);
        else if (btn.dataset.act === 'report')  _showReportModal(a);
    });
}


// HTML-блок чек-боксов тем для использования в формах генерации.
// Возвращает чистый HTML; чтение значений — collectTopicIds(formEl).
function _topicsCheckboxesHtml() {
    const active = _state.topics.filter(t => t.is_active === 'Y');
    if (!active.length) {
        return `<div class="tr-empty" style="padding:12px;">
            Активных тем нет. Создайте тему выше, чтобы привязать её к ссылкам.
        </div>`;
    }
    return `
        <div class="tr-topic-checks">
            ${active.map(t => `
                <label class="tr-topic-check">
                    <input type="checkbox" class="tr-topic-check__cb" value="${t.id}">
                    <span class="tr-topic-check__name">${esc(t.name)}</span>
                    <span class="tr-topic-check__count">${t.question_count || 0} в.</span>
                </label>
            `).join('')}
        </div>`;
}

function _collectTopicIds(scope) {
    return Array.from(scope.querySelectorAll('.tr-topic-check__cb:checked'))
        .map(cb => parseInt(cb.value, 10))
        .filter(Number.isFinite);
}


function _openAttemptForm() {
    document.getElementById('tr-attempt-modal')?.remove();

    const m = document.createElement('div');
    m.id = 'tr-attempt-modal';
    m.className = 'tr-form-modal';
    m.dataset.personId = '';
    m.innerHTML = `
        <div class="tr-form" role="dialog">
            <div class="tr-form__head">
                <span class="tr-form__title">Сгенерировать ссылку на тест</span>
                <button class="btn btn-text btn-sm" data-tr-close type="button">✕</button>
            </div>
            <div class="tr-form__body">
                <label class="tr-field tr-field--full">
                    <span class="tr-field__label">Человек из общей базы *</span>
                    <input type="text" id="tr-att-fio" autocomplete="nope"
                           name="att_fio_${Date.now()}" placeholder="Начните вводить ФИО…">
                    <small class="tr-field__hint" id="tr-att-fio-hint">
                        Выберите человека из подсказки.
                    </small>
                </label>
                <div class="tr-field tr-field--full">
                    <span class="tr-field__label">
                        Темы тестирования (можно выбрать несколько)
                    </span>
                    ${_topicsCheckboxesHtml()}
                </div>
                <label class="tr-field">
                    <span class="tr-field__label">Срок действия, ч.</span>
                    <input type="number" data-f="expires_in_hours" min="1" max="720"
                           placeholder="не ограничен">
                </label>
            </div>
            <div class="tr-form__foot">
                <button class="btn btn-text btn-sm"     data-tr-close type="button">Отмена</button>
                <button class="btn btn-filled btn-sm"   data-tr-save  type="button">Сгенерировать</button>
            </div>
        </div>
    `;
    _state.overlay.appendChild(m);

    const fioInput = m.querySelector('#tr-att-fio');
    const fioHint  = m.querySelector('#tr-att-fio-hint');
    const ac = attachFio(fioInput, {
        onSelect(person) {
            m.dataset.personId = person.id;
            fioHint.textContent = `${person.full_name}` +
                (person.department ? ` · ${person.department}` : '');
            fioHint.style.color = 'var(--md-success, #2c5046)';
        },
    });

    m.querySelectorAll('[data-tr-close]').forEach(b =>
        b.addEventListener('click', () => { ac.destroy(); m.remove(); })
    );
    m.querySelector('[data-tr-save]').addEventListener('click', async () => {
        const personId = parseInt(m.dataset.personId, 10);
        if (!personId) {
            window.showSnackbar?.('Выберите человека из подсказки', 'error');
            return;
        }
        const expiresIn = m.querySelector('[data-f="expires_in_hours"]').value;
        const payload = {
            person_id: personId,
            topic_ids: _collectTopicIds(m),
            expires_in_hours: expiresIn ? parseInt(expiresIn, 10) : null,
        };
        try {
            const created = await api.post('/training/attempts', payload);
            window.showSnackbar?.('Ссылка сгенерирована', 'success');
            ac.destroy(); m.remove();
            await _reloadAttempts();
            _showQrModal(created);
        } catch (err) {
            window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
        }
    });
}


// Массовая генерация для всей активной базы людей
function _openAttemptAllForm() {
    document.getElementById('tr-all-modal')?.remove();
    const m = document.createElement('div');
    m.id = 'tr-all-modal';
    m.className = 'tr-form-modal';
    m.innerHTML = `
        <div class="tr-form" role="dialog">
            <div class="tr-form__head">
                <span class="tr-form__title">Сгенерировать ссылки всем</span>
                <button class="btn btn-text btn-sm" data-tr-close type="button">✕</button>
            </div>
            <div class="tr-form__body">
                <div class="tr-field tr-field--full">
                    <p class="tr-field__hint">
                        Будет создана персональная ссылка для каждого активного
                        человека из общей базы (не уволенного). По умолчанию
                        пропускаем тех, у кого уже есть открытая ссылка от вас,
                        чтобы не дублировать.
                    </p>
                </div>
                <div class="tr-field tr-field--full">
                    <span class="tr-field__label">
                        Темы тестирования (можно выбрать несколько)
                    </span>
                    ${_topicsCheckboxesHtml()}
                </div>
                <label class="tr-field">
                    <span class="tr-field__label">Срок действия, ч.</span>
                    <input type="number" data-f="expires_in_hours" min="1" max="720"
                           placeholder="не ограничен">
                </label>
                <label class="tr-field tr-field--full" style="flex-direction:row; gap:8px; align-items:center;">
                    <input type="checkbox" data-f="skip_existing" checked>
                    <span>Пропустить тех, у кого уже есть открытая ссылка</span>
                </label>
            </div>
            <div class="tr-form__foot">
                <button class="btn btn-text btn-sm"     data-tr-close type="button">Отмена</button>
                <button class="btn btn-filled btn-sm"   data-tr-save  type="button">Сгенерировать всем</button>
            </div>
        </div>
    `;
    _state.overlay.appendChild(m);
    m.querySelectorAll('[data-tr-close]').forEach(b =>
        b.addEventListener('click', () => m.remove())
    );
    m.querySelector('[data-tr-save]').addEventListener('click', async () => {
        const expiresIn  = m.querySelector('[data-f="expires_in_hours"]').value;
        const skip       = m.querySelector('[data-f="skip_existing"]').checked;
        const payload = {
            topic_ids: _collectTopicIds(m),
            expires_in_hours: expiresIn ? parseInt(expiresIn, 10) : null,
            skip_existing: skip,
        };
        const btn = m.querySelector('[data-tr-save]');
        btn.disabled = true; btn.textContent = 'Генерация…';
        try {
            const res = await api.post('/training/attempts/all', payload);
            window.showSnackbar?.(`Создано ссылок: ${res.total}`, 'success');
            m.remove();
            await _reloadAttempts();
        } catch (err) {
            window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
            btn.disabled = false; btn.textContent = 'Сгенерировать всем';
        }
    });
}


// Создать нового человека в общей базе и сразу выдать ему ссылку
function _openPersonAttemptForm() {
    document.getElementById('tr-newperson-modal')?.remove();
    const m = document.createElement('div');
    m.id = 'tr-newperson-modal';
    m.className = 'tr-form-modal';
    m.innerHTML = `
        <div class="tr-form" role="dialog">
            <div class="tr-form__head">
                <span class="tr-form__title">Новый человек + ссылка</span>
                <button class="btn btn-text btn-sm" data-tr-close type="button">✕</button>
            </div>
            <div class="tr-form__body">
                <div class="tr-field tr-field--full">
                    <p class="tr-field__hint">
                        Если такой человек уже есть в общей базе (по ФИО) —
                        будет выдана ссылка существующему. Дубликата не появится.
                    </p>
                </div>
                <label class="tr-field tr-field--full">
                    <span class="tr-field__label">ФИО полностью *</span>
                    <input type="text" data-f="full_name" required maxlength="300"
                           placeholder="Иванов Иван Иванович">
                </label>
                <label class="tr-field">
                    <span class="tr-field__label">Звание</span>
                    <input type="text" data-f="rank" maxlength="100">
                </label>
                <label class="tr-field">
                    <span class="tr-field__label">№ документа</span>
                    <input type="text" data-f="doc_number" maxlength="100">
                </label>
                <label class="tr-field">
                    <span class="tr-field__label">Управление / отдел</span>
                    <input type="text" data-f="department" maxlength="100">
                </label>
                <label class="tr-field">
                    <span class="tr-field__label">Должность</span>
                    <input type="text" data-f="position_title" maxlength="200">
                </label>
                <label class="tr-field">
                    <span class="tr-field__label">Телефон</span>
                    <input type="tel" data-f="phone" maxlength="50" placeholder="+7…">
                </label>
                <div class="tr-field tr-field--full">
                    <span class="tr-field__label">Темы тестирования</span>
                    ${_topicsCheckboxesHtml()}
                </div>
                <label class="tr-field">
                    <span class="tr-field__label">Срок действия, ч.</span>
                    <input type="number" data-f="expires_in_hours" min="1" max="720"
                           placeholder="не ограничен">
                </label>
            </div>
            <div class="tr-form__foot">
                <button class="btn btn-text btn-sm"     data-tr-close type="button">Отмена</button>
                <button class="btn btn-filled btn-sm"   data-tr-save  type="button">Создать и сгенерировать</button>
            </div>
        </div>
    `;
    _state.overlay.appendChild(m);
    m.querySelectorAll('[data-tr-close]').forEach(b =>
        b.addEventListener('click', () => m.remove())
    );
    m.querySelector('[data-tr-save]').addEventListener('click', async () => {
        const get = (k) => m.querySelector(`[data-f="${k}"]`).value.trim();
        const full_name = get('full_name');
        if (!full_name || full_name.split(/\s+/).length < 2) {
            window.showSnackbar?.('Введите ФИО полностью (минимум фамилия и имя)', 'error');
            return;
        }
        const expiresIn = get('expires_in_hours');
        const payload = {
            full_name,
            rank:           get('rank')           || null,
            doc_number:     get('doc_number')     || null,
            department:     get('department')     || null,
            position_title: get('position_title') || null,
            phone:          get('phone')          || null,
            topic_ids:      _collectTopicIds(m),
            expires_in_hours: expiresIn ? parseInt(expiresIn, 10) : null,
        };
        try {
            const created = await api.post('/training/attempts/with-person', payload);
            window.showSnackbar?.('Человек добавлен и ссылка создана', 'success');
            m.remove();
            await _reloadAttempts();
            _showQrModal(created);
        } catch (err) {
            window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
        }
    });
}


function _showQrModal(attempt) {
    document.getElementById('tr-qr-modal')?.remove();
    const m = document.createElement('div');
    m.id = 'tr-qr-modal';
    m.className = 'tr-form-modal';
    const topicLine = (attempt.topic_names || []).join(' · ') || '';
    m.innerHTML = `
        <div class="tr-form tr-qr" role="dialog">
            <div class="tr-form__head">
                <span class="tr-form__title">
                    QR-код для ${esc(attempt.person_full_name || '')}
                    ${topicLine ? `<span class="tr-qr__topics">${esc(topicLine)}</span>` : ''}
                </span>
                <button class="btn btn-text btn-sm" data-tr-close type="button">✕</button>
            </div>
            <div class="tr-form__body tr-qr__body">
                <div class="tr-qr__img" id="tr-qr-img">
                    <div class="tr-loading">Генерация QR…</div>
                </div>
                <div class="tr-qr__url-block">
                    <div class="tr-qr__url-label">Ссылка для отправки в мессенджере:</div>
                    <div class="tr-qr__url" id="tr-qr-url">${esc(attempt.url)}</div>
                    <button class="btn btn-outlined btn-sm" id="tr-qr-copy" type="button">
                        ⎘ Скопировать ссылку
                    </button>
                </div>
                <p class="tr-qr__hint">
                    Сотрудник сканирует QR с телефона (находясь в одной локальной
                    сети с платформой) или открывает ссылку в браузере. ФИО уже
                    привязано к ссылке — заполняет только телефон, управление
                    и должность.
                </p>
            </div>
            <div class="tr-form__foot">
                <button class="btn btn-outlined btn-sm" id="tr-qr-print" type="button">
                    🖨 Печать
                </button>
                <button class="btn btn-text btn-sm"     data-tr-close   type="button">Закрыть</button>
            </div>
        </div>
    `;
    _state.overlay.appendChild(m);

    // Грузим SVG QR из бэкенда (один сетевой запрос)
    fetch(`/api/v1/training/attempts/${attempt.id}/qr.svg?scale=8`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
    })
        .then(r => r.ok ? r.text() : Promise.reject(r.status))
        .then(svg => { m.querySelector('#tr-qr-img').innerHTML = svg; })
        .catch(() => {
            m.querySelector('#tr-qr-img').innerHTML =
                '<div class="tr-error">Не удалось загрузить QR</div>';
        });

    m.querySelectorAll('[data-tr-close]').forEach(b =>
        b.addEventListener('click', () => m.remove())
    );
    m.querySelector('#tr-qr-copy').addEventListener('click', () => _copyUrl(attempt.url));
    m.querySelector('#tr-qr-print').addEventListener('click', () => _printQr(attempt));
}


function _copyUrl(url) {
    if (!url) return;
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url)
            .then(() => window.showSnackbar?.('Ссылка скопирована', 'success'))
            .catch(() => window.showSnackbar?.('Не удалось скопировать', 'error'));
    } else {
        // Fallback для старых браузеров
        const ta = document.createElement('textarea');
        ta.value = url; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy'); ta.remove();
        window.showSnackbar?.('Ссылка скопирована', 'success');
    }
}


// Открывает страницу с QR в новом окне для печати — удобно когда надо
// раздать бумажные QR-карточки группе.
function _printQr(attempt) {
    const w = window.open('', '_blank', 'width=600,height=800');
    if (!w) {
        window.showSnackbar?.('Окно печати заблокировано браузером', 'error');
        return;
    }
    fetch(`/api/v1/training/attempts/${attempt.id}/qr.svg?scale=10`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
    })
        .then(r => r.text())
        .then(svg => {
            w.document.write(`
                <!DOCTYPE html>
                <html><head><meta charset="UTF-8"><title>QR — ${esc(attempt.person_full_name || '')}</title>
                <style>
                    body { font-family: sans-serif; text-align: center; padding: 40px; }
                    h2   { margin: 0 0 4px; }
                    .url { font-family: monospace; font-size: 12px; color: #555; margin-top: 8px; }
                    svg  { display: block; margin: 24px auto; max-width: 360px; }
                </style></head><body>
                    <h2>${esc(attempt.person_full_name || '')}</h2>
                    ${(attempt.topic_names || []).length
                        ? `<div>Темы: ${esc((attempt.topic_names || []).join(' · '))}</div>`
                        : ''}
                    ${svg}
                    <div class="url">${esc(attempt.url)}</div>
                </body></html>
            `);
            w.document.close();
            w.focus();
            setTimeout(() => w.print(), 300);
        });
}


async function _revokeAttempt(attempt) {
    if (!window.confirm(
        `Отозвать ссылку для «${attempt.person_full_name || '—'}»?\n` +
        `После отзыва человек больше не сможет открыть тест по этой ссылке.`
    )) return;
    try {
        await api.delete(`/training/attempts/${attempt.id}`);
        window.showSnackbar?.('Ссылка отозвана', 'success');
        await _reloadAttempts();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
    }
}


// ─── Отчёт по попытке ──────────────────────────────────────────────────────

async function _showReportModal(attempt) {
    document.getElementById('tr-report-modal')?.remove();
    const m = document.createElement('div');
    m.id = 'tr-report-modal';
    m.className = 'tr-form-modal';
    m.innerHTML = `
        <div class="tr-form tr-report" role="dialog" style="width: min(960px, 100%); max-height: 94%;">
            <div class="tr-form__head">
                <span class="tr-form__title">Отчёт по тесту</span>
                <button class="btn btn-text btn-sm" data-tr-close type="button">✕</button>
            </div>
            <div class="tr-form__body" style="grid-template-columns:none; padding: 0;">
                <div id="tr-report-body">
                    <div class="tr-loading">Загрузка отчёта…</div>
                </div>
            </div>
            <div class="tr-form__foot">
                <button class="btn btn-outlined btn-sm" id="tr-report-print" type="button">
                    🖨 Печать
                </button>
                <div style="flex:1"></div>
                <button class="btn btn-text btn-sm" data-tr-close type="button">Закрыть</button>
            </div>
        </div>
    `;
    _state.overlay.appendChild(m);
    m.querySelectorAll('[data-tr-close]').forEach(b =>
        b.addEventListener('click', () => m.remove())
    );

    let report;
    try {
        report = await api.get(`/training/attempts/${attempt.id}/report`);
    } catch (err) {
        m.querySelector('#tr-report-body').innerHTML =
            `<div class="tr-error" style="margin: 14px;">Ошибка: ${esc(err.message || '')}</div>`;
        return;
    }
    _renderReport(m.querySelector('#tr-report-body'), report);
    m.querySelector('#tr-report-print').addEventListener('click',
        () => _printReport(report));
}


function _renderReport(container, r) {
    const passClass = r.passed === true  ? 'tr-rep-result--ok'
                    : r.passed === false ? 'tr-rep-result--fail'
                    :                       '';
    const passLabel = r.passed === true  ? '✓ Тест пройден'
                    : r.passed === false ? '✕ Тест не пройден'
                    :                       'Завершён';
    const percentTxt = r.percent != null ? `${r.percent}%` : '—';

    const fmtDur = (sec) => {
        if (!sec) return '—';
        const m = Math.floor(sec / 60), s = sec % 60;
        return m > 0 ? `${m} мин ${s} сек` : `${s} сек`;
    };

    const meta = [
        r.form_department ? ['Управление',  r.form_department] : null,
        r.form_position   ? ['Должность',   r.form_position]   : null,
        r.form_phone      ? ['Телефон',     r.form_phone]      : null,
        r.topic_names?.length ? ['Темы',     r.topic_names.join(' · ')] : null,
        r.registered_at   ? ['Заполнил анкету', fmtDateTime(r.registered_at)] : null,
        r.started_at      ? ['Начал тест',  fmtDateTime(r.started_at)]  : null,
        r.completed_at    ? ['Завершил',    fmtDateTime(r.completed_at)] : null,
        r.duration_seconds!=null ? ['Длительность', fmtDur(r.duration_seconds)] : null,
        r.pass_threshold!=null  ? ['Проходной балл', `${r.pass_threshold}%`] : null,
    ].filter(Boolean);

    container.innerHTML = `
        <div class="tr-rep">
            <div class="tr-rep__head">
                <div class="tr-rep__person">
                    <div class="tr-rep__name">${esc(r.person_full_name || '—')}</div>
                    <div class="tr-rep__sub">
                        ${r.form_department ? esc(r.form_department) : ''}
                        ${r.form_phone ? ' · ' + esc(r.form_phone) : ''}
                    </div>
                </div>
                ${r.status === 'completed' ? `
                    <div class="tr-rep-result ${passClass}">
                        <div class="tr-rep-result__big">${percentTxt}</div>
                        <div class="tr-rep-result__label">${passLabel}</div>
                        <div class="tr-rep-result__rows">
                            <div>Правильных: <b>${r.correct_count}</b> из ${r.questions_count}</div>
                            <div>Баллов: <b>${r.score ?? 0}</b> из ${r.total_points}</div>
                        </div>
                    </div>
                ` : `
                    <div class="tr-rep-result tr-rep-result--pending">
                        <div class="tr-rep-result__label">Тест ещё не завершён</div>
                        <div class="tr-rep-result__rows">
                            <div>Статус: <b>${esc(STATUS_LABELS[r.status] || r.status)}</b></div>
                            <div>Вопросов в тесте: ${r.questions_count}</div>
                        </div>
                    </div>
                `}
            </div>

            <div class="tr-rep__meta">
                ${meta.map(([k, v]) => `
                    <div class="tr-rep__meta-row">
                        <span class="tr-rep__meta-key">${esc(k)}</span>
                        <span class="tr-rep__meta-val">${esc(v)}</span>
                    </div>
                `).join('')}
            </div>

            <div class="tr-rep__qhead">Ответы (${r.answers.length})</div>
            <div class="tr-rep__questions">
                ${r.answers.map((a, i) => _renderReportQuestion(a, i + 1)).join('')}
            </div>
        </div>
    `;
}


function _renderReportQuestion(a, num) {
    let cardCls = 'tr-rep-q';
    let badge = '';
    if (a.is_unanswered) {
        cardCls += ' tr-rep-q--skip';
        badge = '<span class="tr-rep-q__badge tr-rep-q__badge--skip">без ответа</span>';
    } else if (a.is_correct) {
        cardCls += ' tr-rep-q--ok';
        badge = '<span class="tr-rep-q__badge tr-rep-q__badge--ok">✓ верно</span>';
    } else {
        cardCls += ' tr-rep-q--fail';
        badge = '<span class="tr-rep-q__badge tr-rep-q__badge--fail">✕ неверно</span>';
    }

    return `
        <div class="${cardCls}">
            <div class="tr-rep-q__head">
                <span class="tr-rep-q__num">№ ${num}</span>
                ${badge}
                <span class="tr-rep-q__points">${a.points} б.</span>
            </div>
            <div class="tr-rep-q__text">${esc(a.question_text)}</div>
            <ul class="tr-rep-q__opts">
                ${a.options.map(o => {
                    let cls = 'tr-rep-opt';
                    let icon = '○';
                    let labels = [];
                    if (o.correct && o.selected) {
                        cls += ' tr-rep-opt--correct-selected'; icon = '✓';
                        labels.push('правильный', 'выбран');
                    } else if (o.correct) {
                        cls += ' tr-rep-opt--correct-unselected'; icon = '◎';
                        labels.push('правильный');
                    } else if (o.selected) {
                        cls += ' tr-rep-opt--wrong-selected'; icon = '✕';
                        labels.push('выбран ошибочно');
                    }
                    return `
                        <li class="${cls}">
                            <span class="tr-rep-opt__icon">${icon}</span>
                            <span class="tr-rep-opt__text">${esc(o.text)}</span>
                            ${labels.length
                                ? `<span class="tr-rep-opt__tags">${labels.map(l =>
                                    `<span class="tr-rep-opt__tag">${esc(l)}</span>`
                                  ).join('')}</span>`
                                : ''}
                        </li>`;
                }).join('')}
            </ul>
        </div>
    `;
}


// Открывает чистую страницу для печати — удобно когда нужен бумажный отчёт
function _printReport(r) {
    const w = window.open('', '_blank', 'width=900,height=1100');
    if (!w) {
        window.showSnackbar?.('Окно печати заблокировано браузером', 'error');
        return;
    }
    w.document.write(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Отчёт — ${esc(r.person_full_name || '')}</title>
        <style>
            * { box-sizing: border-box; }
            body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; padding: 24px; color: #1a2024; }
            h1 { margin: 0 0 4px; font-size: 18px; }
            .sub { color: #5b6770; font-size: 13px; }
            .summary {
                margin: 16px 0; padding: 12px 16px;
                border: 1.5px solid #2c5046;
                border-radius: 8px;
                display: flex; gap: 24px; align-items: center;
            }
            .summary.fail { border-color: #b85450; }
            .big { font-size: 28px; font-weight: 700; color: #2c5046; }
            .summary.fail .big { color: #b85450; }
            .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 24px; font-size: 13px; margin: 16px 0; }
            .meta-row { display: flex; justify-content: space-between; border-bottom: 1px dotted #ccc; padding: 3px 0; }
            .meta-row span:first-child { color: #5b6770; }
            .q { border: 1px solid #e0e4e8; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; page-break-inside: avoid; }
            .q.ok   { border-left: 4px solid #2e7d32; }
            .q.fail { border-left: 4px solid #b85450; }
            .q.skip { border-left: 4px solid #d4a017; }
            .q-head { display: flex; gap: 10px; align-items: center; font-size: 12px; color: #5b6770; margin-bottom: 4px; }
            .q-text { font-weight: 500; margin-bottom: 6px; }
            .opts { list-style: none; padding: 0; margin: 0; }
            .opts li { padding: 3px 6px; font-size: 13px; border-radius: 4px; margin: 2px 0; }
            .opts li.cs { background: #d4f1d4; color: #2e7d32; font-weight: 500; }
            .opts li.cu { background: #fff8e1; }
            .opts li.ws { background: #fce8e6; color: #b85450; text-decoration: line-through; }
        </style></head><body>
            <h1>${esc(r.person_full_name || '—')}</h1>
            <div class="sub">
                ${esc((r.form_department || '') + (r.form_phone ? ' · ' + r.form_phone : ''))}
            </div>
            <div class="summary ${r.passed === false ? 'fail' : ''}">
                <div class="big">${r.percent != null ? r.percent + '%' : '—'}</div>
                <div>
                    <div><b>${r.passed === true ? '✓ Тест пройден' : r.passed === false ? '✕ Тест не пройден' : 'Завершён'}</b></div>
                    <div>Правильных ${r.correct_count} из ${r.questions_count} · Баллов ${r.score ?? 0} из ${r.total_points}</div>
                </div>
            </div>
            <div class="meta">
                ${r.topic_names?.length    ? `<div class="meta-row"><span>Темы</span><span>${esc(r.topic_names.join(' · '))}</span></div>` : ''}
                ${r.registered_at  ? `<div class="meta-row"><span>Заполнил анкету</span><span>${esc(fmtDateTime(r.registered_at))}</span></div>` : ''}
                ${r.started_at     ? `<div class="meta-row"><span>Начал тест</span><span>${esc(fmtDateTime(r.started_at))}</span></div>` : ''}
                ${r.completed_at   ? `<div class="meta-row"><span>Завершил</span><span>${esc(fmtDateTime(r.completed_at))}</span></div>` : ''}
                ${r.pass_threshold != null ? `<div class="meta-row"><span>Проходной балл</span><span>${r.pass_threshold}%</span></div>` : ''}
            </div>
            <h3>Ответы</h3>
            ${r.answers.map((a, i) => `
                <div class="q ${a.is_unanswered ? 'skip' : a.is_correct ? 'ok' : 'fail'}">
                    <div class="q-head">
                        <span>№ ${i + 1}</span>
                        <span>${a.is_unanswered ? 'без ответа' : a.is_correct ? '✓ верно' : '✕ неверно'}</span>
                        <span>· ${a.points} б.</span>
                    </div>
                    <div class="q-text">${esc(a.question_text)}</div>
                    <ul class="opts">
                        ${a.options.map(o => {
                            let cls = '';
                            if (o.correct && o.selected) cls = 'cs';
                            else if (o.correct)          cls = 'cu';
                            else if (o.selected)         cls = 'ws';
                            return `<li class="${cls}">${esc(o.text)}</li>`;
                        }).join('')}
                    </ul>
                </div>
            `).join('')}
        </body></html>
    `);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
}


// ─── Сводный отчёт ─────────────────────────────────────────────────────────

const _summaryFilters = { topic_id: '', department: '', date_from: '', date_to: '' };

async function _openSummaryReport() {
    document.getElementById('tr-summary-modal')?.remove();

    const m = document.createElement('div');
    m.id = 'tr-summary-modal';
    m.className = 'tr-form-modal';
    m.innerHTML = `
        <div class="tr-form tr-summary" role="dialog"
             style="width: min(1100px, 100%); max-height: 96%;">
            <div class="tr-form__head">
                <div>
                    <span class="tr-form__title">Сводный отчёт по тестам</span>
                    <div class="tr-summary__sub">
                        Агрегаты, разрезы по подразделениям и темам, топы.
                    </div>
                </div>
                <button class="btn btn-text btn-sm" data-tr-close type="button">✕</button>
            </div>
            <div class="tr-summary__filters">
                <label class="tr-field">
                    <span class="tr-field__label">Тема</span>
                    <select id="tr-sum-topic">
                        <option value="">Все темы</option>
                        ${_state.topics.map(t =>
                            `<option value="${t.id}">${esc(t.name)}</option>`
                        ).join('')}
                    </select>
                </label>
                <label class="tr-field">
                    <span class="tr-field__label">Подразделение</span>
                    <input type="text" id="tr-sum-dept"
                           placeholder="напр. 1 Управление">
                </label>
                <label class="tr-field">
                    <span class="tr-field__label">С даты</span>
                    <input type="date" id="tr-sum-from">
                </label>
                <label class="tr-field">
                    <span class="tr-field__label">По дату</span>
                    <input type="date" id="tr-sum-to">
                </label>
                <button class="btn btn-filled btn-sm" id="tr-sum-apply" type="button">
                    Применить
                </button>
                <button class="btn btn-outlined btn-sm" id="tr-sum-reset" type="button">
                    Сбросить
                </button>
            </div>
            <div class="tr-form__body" style="grid-template-columns:none; padding: 14px 22px;">
                <div id="tr-summary-body">
                    <div class="tr-loading">Загрузка отчёта…</div>
                </div>
            </div>
            <div class="tr-form__foot">
                <button class="btn btn-outlined btn-sm" id="tr-sum-print" type="button">
                    🖨 Печать
                </button>
                <div style="flex:1"></div>
                <button class="btn btn-text btn-sm" data-tr-close type="button">Закрыть</button>
            </div>
        </div>
    `;
    _state.overlay.appendChild(m);
    m.querySelectorAll('[data-tr-close]').forEach(b =>
        b.addEventListener('click', () => m.remove())
    );

    // Восстанавливаем последние фильтры
    m.querySelector('#tr-sum-topic').value = _summaryFilters.topic_id;
    m.querySelector('#tr-sum-dept').value  = _summaryFilters.department;
    m.querySelector('#tr-sum-from').value  = _summaryFilters.date_from;
    m.querySelector('#tr-sum-to').value    = _summaryFilters.date_to;

    m.querySelector('#tr-sum-apply').addEventListener('click', () => {
        _summaryFilters.topic_id   = m.querySelector('#tr-sum-topic').value;
        _summaryFilters.department = m.querySelector('#tr-sum-dept').value.trim();
        _summaryFilters.date_from  = m.querySelector('#tr-sum-from').value;
        _summaryFilters.date_to    = m.querySelector('#tr-sum-to').value;
        _loadSummary(m);
    });
    m.querySelector('#tr-sum-reset').addEventListener('click', () => {
        _summaryFilters.topic_id = ''; _summaryFilters.department = '';
        _summaryFilters.date_from = ''; _summaryFilters.date_to = '';
        m.querySelector('#tr-sum-topic').value = '';
        m.querySelector('#tr-sum-dept').value  = '';
        m.querySelector('#tr-sum-from').value  = '';
        m.querySelector('#tr-sum-to').value    = '';
        _loadSummary(m);
    });

    let lastReport = null;
    m.querySelector('#tr-sum-print').addEventListener('click', () => {
        if (lastReport) _printSummary(lastReport);
    });
    // Сохраняем ссылку на отчёт чтобы print мог его взять
    m._getReport = () => lastReport;
    await _loadSummary(m);
    lastReport = m._lastReport;  // не используется, но оставляем для будущего
}


async function _loadSummary(modal) {
    const body = modal.querySelector('#tr-summary-body');
    body.innerHTML = `<div class="tr-loading">Загрузка отчёта…</div>`;
    const params = new URLSearchParams();
    if (_summaryFilters.topic_id)   params.set('topic_id',   _summaryFilters.topic_id);
    if (_summaryFilters.department) params.set('department', _summaryFilters.department);
    if (_summaryFilters.date_from)  params.set('date_from',  _summaryFilters.date_from);
    if (_summaryFilters.date_to)    params.set('date_to',    _summaryFilters.date_to);
    try {
        const r = await api.get(`/training/reports/summary?${params.toString()}`);
        modal._lastReport = r;
        _renderSummary(body, r);
        // обновим колбэк print, чтобы был свежий отчёт
        modal.querySelector('#tr-sum-print').onclick = () => _printSummary(r);
    } catch (err) {
        body.innerHTML = `<div class="tr-error">Ошибка: ${esc(err.message || '')}</div>`;
    }
}


function _renderSummary(body, r) {
    // KPI-карточки
    const kpi = (label, value, tone='') => `
        <div class="tr-kpi ${tone ? 'tr-kpi--' + tone : ''}">
            <div class="tr-kpi__value">${value ?? '—'}</div>
            <div class="tr-kpi__label">${esc(label)}</div>
        </div>`;

    const passRate = (r.passed + r.failed) > 0
        ? Math.round(r.passed / (r.passed + r.failed) * 100) : null;

    // Гистограмма (бары)
    const maxBucket = Math.max(1, ...r.histogram.map(h => h.count));
    const histHtml = r.histogram.map(h => {
        const pct = Math.round(h.count / maxBucket * 100);
        return `
            <div class="tr-hist__row">
                <span class="tr-hist__label">${esc(h.range)}</span>
                <div class="tr-hist__bar"><div class="tr-hist__fill"
                     style="width:${pct}%"></div></div>
                <span class="tr-hist__count">${h.count}</span>
            </div>`;
    }).join('');

    // Таблицы группировок
    const groupTable = (rows, keyLabel) => `
        <table class="tr-grp">
            <thead>
                <tr>
                    <th>${esc(keyLabel)}</th>
                    <th class="tr-grp__num">Всего</th>
                    <th class="tr-grp__num">Завершено</th>
                    <th class="tr-grp__num">Прошли</th>
                    <th class="tr-grp__num">Не прошли</th>
                    <th class="tr-grp__num">Среднее %</th>
                </tr>
            </thead>
            <tbody>
                ${rows.length === 0
                    ? `<tr><td colspan="6" class="tr-empty" style="padding:14px;">
                            Нет данных по этому срезу.</td></tr>`
                    : rows.map(g => `
                        <tr>
                            <td class="tr-grp__label">${esc(g.label)}</td>
                            <td class="tr-grp__num">${g.total}</td>
                            <td class="tr-grp__num">${g.completed}</td>
                            <td class="tr-grp__num tr-grp__num--ok">${g.passed}</td>
                            <td class="tr-grp__num tr-grp__num--fail">${g.failed}</td>
                            <td class="tr-grp__num">${g.avg_percent != null
                                ? g.avg_percent + '%' : '—'}</td>
                        </tr>`).join('')}
            </tbody>
        </table>`;

    const performersHtml = (rows, title) => {
        if (!rows.length) return '';
        return `
            <div class="tr-perf">
                <div class="tr-perf__title">${esc(title)}</div>
                <ul class="tr-perf__list">
                    ${rows.map(p => `
                        <li>
                            <span class="tr-perf__name">${esc(p.person_full_name || '—')}</span>
                            <span class="tr-perf__dept">${esc(p.department || '')}</span>
                            <span class="tr-perf__pct">${p.percent != null ? p.percent + '%' : '—'}</span>
                        </li>
                    `).join('')}
                </ul>
            </div>`;
    };

    body.innerHTML = `
        <div class="tr-sum-grid">
            ${kpi('Всего ссылок',   r.total,       'total')}
            ${kpi('Завершено',      r.completed,   'ok')}
            ${kpi('Идёт тест',      r.in_progress, 'progress')}
            ${kpi('Анкета без теста', r.registered)}
            ${kpi('Не открыли',     r.created)}
            ${kpi('Отозвано',       r.expired)}
            ${kpi('Среднее %',      r.avg_percent != null ? r.avg_percent + '%' : '—', 'accent')}
            ${kpi('Прошли проходной', r.passed,    'ok')}
            ${kpi('Не прошли',      r.failed,      'fail')}
            ${passRate != null ? kpi('% сдачи', passRate + '%', 'accent') : ''}
        </div>

        ${(r.histogram || []).some(h => h.count > 0) ? `
            <div class="tr-sum-section">
                <div class="tr-sum-section__title">Распределение результатов</div>
                <div class="tr-hist">${histHtml}</div>
            </div>
        ` : ''}

        <div class="tr-sum-section">
            <div class="tr-sum-section__title">По подразделениям</div>
            ${groupTable(r.by_department, 'Подразделение')}
        </div>

        <div class="tr-sum-section">
            <div class="tr-sum-section__title">По темам</div>
            ${groupTable(r.by_topic, 'Тема')}
        </div>

        ${(r.top_performers.length || r.bottom_performers.length) ? `
            <div class="tr-sum-section">
                <div class="tr-sum-section__title">Топ результатов</div>
                <div class="tr-perf-grid">
                    ${performersHtml(r.top_performers,    '🏆 Лучшие')}
                    ${performersHtml(r.bottom_performers, '⚠ Слабые')}
                </div>
            </div>
        ` : ''}
    `;
}


// Печать сводного отчёта в отдельной вкладке
function _printSummary(r) {
    const w = window.open('', '_blank', 'width=1100,height=1300');
    if (!w) {
        window.showSnackbar?.('Окно печати заблокировано браузером', 'error');
        return;
    }
    const groupRows = (rows) => rows.map(g => `
        <tr>
            <td>${esc(g.label)}</td>
            <td>${g.total}</td>
            <td>${g.completed}</td>
            <td>${g.passed}</td>
            <td>${g.failed}</td>
            <td>${g.avg_percent != null ? g.avg_percent + '%' : '—'}</td>
        </tr>
    `).join('');

    const perfRows = (rows) => rows.map(p => `
        <tr>
            <td>${esc(p.person_full_name || '—')}</td>
            <td>${esc(p.department || '')}</td>
            <td>${p.percent != null ? p.percent + '%' : '—'}</td>
        </tr>
    `).join('');

    w.document.write(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Сводный отчёт</title>
        <style>
            body { font-family: sans-serif; padding: 24px; color: #1a2024; }
            h1 { margin: 0 0 4px; font-size: 20px; }
            .filters { color: #5b6770; font-size: 12px; margin-bottom: 14px; }
            h3 { margin: 16px 0 6px; font-size: 14px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
            .kpi { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 16px; }
            .kpi-cell { border: 1px solid #ccc; padding: 6px 10px; border-radius: 4px; }
            .kpi-cell .v { font-size: 18px; font-weight: bold; }
            .kpi-cell .l { font-size: 11px; color: #5b6770; }
            table { border-collapse: collapse; width: 100%; font-size: 12px; margin-bottom: 12px; }
            th, td { border: 1px solid #ccc; padding: 5px 8px; text-align: left; }
            th { background: #f5f5f5; }
            td:nth-child(n+2), th:nth-child(n+2) { text-align: right; }
        </style></head><body>
            <h1>Сводный отчёт по тестам</h1>
            <div class="filters">
                Фильтры: ${esc(JSON.stringify(r.filters))}
            </div>
            <div class="kpi">
                <div class="kpi-cell"><div class="v">${r.total}</div><div class="l">Всего ссылок</div></div>
                <div class="kpi-cell"><div class="v">${r.completed}</div><div class="l">Завершено</div></div>
                <div class="kpi-cell"><div class="v">${r.passed}</div><div class="l">Прошли</div></div>
                <div class="kpi-cell"><div class="v">${r.failed}</div><div class="l">Не прошли</div></div>
                <div class="kpi-cell"><div class="v">${r.avg_percent != null ? r.avg_percent + '%' : '—'}</div><div class="l">Среднее %</div></div>
            </div>
            <h3>По подразделениям</h3>
            <table>
                <thead><tr><th>Подразделение</th><th>Всего</th><th>Завершено</th><th>Прошли</th><th>Не прошли</th><th>Среднее %</th></tr></thead>
                <tbody>${groupRows(r.by_department) || '<tr><td colspan="6">—</td></tr>'}</tbody>
            </table>
            <h3>По темам</h3>
            <table>
                <thead><tr><th>Тема</th><th>Всего</th><th>Завершено</th><th>Прошли</th><th>Не прошли</th><th>Среднее %</th></tr></thead>
                <tbody>${groupRows(r.by_topic) || '<tr><td colspan="6">—</td></tr>'}</tbody>
            </table>
            ${r.top_performers.length ? `
                <h3>Лучшие</h3>
                <table>
                    <thead><tr><th>ФИО</th><th>Подразделение</th><th>%</th></tr></thead>
                    <tbody>${perfRows(r.top_performers)}</tbody>
                </table>
            ` : ''}
            ${r.bottom_performers.length ? `
                <h3>Слабые</h3>
                <table>
                    <thead><tr><th>ФИО</th><th>Подразделение</th><th>%</th></tr></thead>
                    <tbody>${perfRows(r.bottom_performers)}</tbody>
                </table>
            ` : ''}
        </body></html>
    `);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
}
