// static/js/training_public.js
//
// Логика публичной страницы тестирования.
// Открывается по URL вида /training/{token}. Авторизации нет — token
// сам и есть ключ доступа. Шаги:
//   1. GET /api/v1/training/public/{token} → инфо для предзаполнения
//   2. По полю next_step выбираем шаблон UI:
//        register   — форма «телефон/управление/должность»
//        test       — этап теста (заглушка: «ждите»)
//        completed  — тест завершён
//        expired    — ссылка просрочена/отозвана
//   3. POST .../register → переходим на этап test

const API = '/api/v1/training';

// Извлекаем токен из URL: /training/{token}.
function extractToken() {
    const m = window.location.pathname.match(/\/training\/([^/?#]+)/);
    return m ? m[1] : null;
}

// Безопасно подставляет текст в [data-fio], [data-topic] внутри узла.
function fill(node, info) {
    const fio = node.querySelector('[data-fio]');
    if (fio) fio.textContent = info.person_full_name || '—';
    const topic = node.querySelector('[data-topic]');
    if (topic) {
        const names = Array.isArray(info.topic_names) ? info.topic_names : [];
        topic.textContent = names.length
            ? (names.length === 1 ? `Тема: ${names[0]}`
                                  : `Темы: ${names.join(' · ')}`)
            : '';
    }
}

function renderTemplate(id, info) {
    const tpl  = document.getElementById(id);
    const card = document.getElementById('tp-card');
    if (!tpl || !card) return;
    card.innerHTML = '';
    const node = tpl.content.firstElementChild.cloneNode(true);
    fill(node, info);
    card.appendChild(node);
    return node;
}

function showError(msg) {
    const card = document.getElementById('tp-card');
    card.innerHTML = `
        <div class="tp-step tp-step--error">
            <h1 class="tp-title">Ошибка</h1>
            <p class="tp-hint">${msg}</p>
        </div>`;
}

async function loadInfo(token) {
    const res = await fetch(`${API}/public/${encodeURIComponent(token)}`);
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 410)        return { _expired: true };
        if (res.status === 404)        throw new Error('Ссылка не найдена');
        throw new Error(data.detail || `Ошибка ${res.status}`);
    }
    return res.json();
}

async function submitRegister(token, payload) {
    const res = await fetch(`${API}/public/${encodeURIComponent(token)}/register`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Ошибка ${res.status}`);
    return data;
}

async function loadTest(token) {
    const res = await fetch(`${API}/public/${encodeURIComponent(token)}/test`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Ошибка ${res.status}`);
    return data;
}

async function submitTest(token, answers) {
    const res = await fetch(`${API}/public/${encodeURIComponent(token)}/submit`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ answers }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Ошибка ${res.status}`);
    return data;
}

function bindForm(token, info) {
    const form = document.getElementById('tp-form');
    const err  = document.getElementById('tp-error');
    if (!form) return;

    // Предзаполнение: department/phone из общей базы людей, если есть.
    const deptInput  = form.elements.namedItem('department');
    const phoneInput = form.elements.namedItem('phone');
    if (deptInput  && info.person_department) deptInput.value  = info.person_department;
    if (phoneInput && info.person_phone)      phoneInput.value = info.person_phone;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.hidden = true;
        err.textContent = '';

        const fd = new FormData(form);
        const payload = {
            phone:      String(fd.get('phone')      || '').trim(),
            department: String(fd.get('department') || '').trim(),
        };
        if (!payload.phone || !payload.department) {
            err.hidden = false;
            err.textContent = 'Заполните обязательные поля.';
            return;
        }

        const submitBtn = form.querySelector('.tp-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Отправка…';

        try {
            const updated = await submitRegister(token, payload);
            // После успешной регистрации сразу переходим к этапу теста —
            // тест запускается автоматически без дополнительных действий.
            await renderByStep(updated, token);
        } catch (e) {
            err.hidden = false;
            err.textContent = e.message || 'Не удалось отправить данные.';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Продолжить →';
        }
    });
}


// ─── Этап «Тест» ───────────────────────────────────────────────────────────

function htmlEscape(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function renderTestStep(token, info) {
    const node = renderTemplate('tpl-test', info);
    const card = document.getElementById('tp-card');

    let testData;
    try {
        testData = await loadTest(token);
    } catch (e) {
        // Распространённые случаи: 400 = нет вопросов в темах
        card.innerHTML = `
            <div class="tp-step">
                <h1 class="tp-title">✓ Анкета принята</h1>
                <p class="tp-hello">Спасибо, <b>${htmlEscape(info.person_full_name || '—')}</b></p>
                <p class="tp-hint">${htmlEscape(e.message || 'Тест ещё не готов')}</p>
                <p class="tp-hint tp-hint--muted">
                    Свяжитесь с организатором или обновите эту страницу позже.
                </p>
            </div>`;
        return;
    }

    // Заголовок темы(тем)
    const topicSpan = node.querySelector('[data-topic]');
    if (topicSpan) {
        const names = testData.topic_names || [];
        topicSpan.textContent = names.length
            ? ' · ' + (names.length === 1 ? names[0] : names.join(' · '))
            : '';
    }

    const fioEl = node.querySelector('[data-fio]');
    if (fioEl) fioEl.textContent = testData.person_full_name || info.person_full_name || '—';

    const progressEl = node.querySelector('[data-progress]');
    const total = testData.questions.length;
    if (progressEl) {
        progressEl.textContent = `${total} ${pluralize(total, 'вопрос', 'вопроса', 'вопросов')}`
            + (testData.duration_minutes ? ` · ~${testData.duration_minutes} мин` : '')
            + (testData.pass_threshold   ? ` · проходной ${testData.pass_threshold}%` : '');
    }

    const qList = node.querySelector('#tp-questions');
    qList.innerHTML = testData.questions.map((q, i) => {
        // Если у вопроса несколько правильных — multi-select (checkbox).
        // На фронте мы не знаем сколько правильных, поэтому даём радио по умолчанию;
        // если пользователь должен выбрать несколько — admin-form предупредит.
        // Простое правило: всегда radio (один правильный) — самый частый кейс.
        // Если в будущем понадобятся multi — переключим тип через флаг вопроса.
        return `
            <div class="tp-q" data-q-id="${q.id}">
                <div class="tp-q__num">Вопрос ${i + 1} из ${total}</div>
                <div class="tp-q__text">${htmlEscape(q.text)}</div>
                <div class="tp-q__opts">
                    ${q.options.map(o => `
                        <label class="tp-q__opt">
                            <input type="radio" name="q_${q.id}" value="${o.idx}">
                            <span>${htmlEscape(o.text)}</span>
                        </label>
                    `).join('')}
                </div>
            </div>`;
    }).join('');

    const form  = node.querySelector('#tp-test-form');
    const errEl = node.querySelector('#tp-test-error');
    const btn   = node.querySelector('#tp-test-submit');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.hidden = true;
        errEl.textContent = '';

        // Собираем ответы
        const answers = testData.questions.map(q => {
            const checked = form.querySelector(
                `input[name="q_${q.id}"]:checked`
            );
            return {
                question_id: q.id,
                selected:    checked ? [parseInt(checked.value, 10)] : [],
            };
        });

        const unanswered = answers.filter(a => a.selected.length === 0).length;
        if (unanswered > 0) {
            if (!confirm(`Без ответа: ${unanswered}. Всё равно завершить тест?`)) return;
        }

        btn.disabled = true;
        btn.textContent = 'Отправка ответов…';
        try {
            const result = await submitTest(token, answers);
            renderResult(result, testData.person_full_name || info.person_full_name);
        } catch (e) {
            errEl.hidden = false;
            errEl.textContent = e.message || 'Не удалось отправить ответы.';
            btn.disabled = false;
            btn.textContent = 'Завершить тест';
        }
    });
}


function renderResult(result, fullName) {
    const card = document.getElementById('tp-card');
    card.innerHTML = '';
    const tpl  = document.getElementById('tpl-completed');
    const node = tpl.content.firstElementChild.cloneNode(true);

    const fioEl = node.querySelector('[data-fio]');
    if (fioEl) fioEl.textContent = fullName || '—';

    const titleEl = node.querySelector('[data-result-title]');
    if (titleEl) {
        if (result.passed === true)       titleEl.textContent = '✓ Тест пройден';
        else if (result.passed === false) titleEl.textContent = '✕ Тест не пройден';
        else                              titleEl.textContent = 'Тест завершён';
    }

    const resultEl = node.querySelector('[data-result]');
    if (resultEl) {
        const passClass = result.passed === true  ? 'tp-result--ok'
                        : result.passed === false ? 'tp-result--fail'
                        :                            '';
        resultEl.className = `tp-result ${passClass}`;
        resultEl.innerHTML = `
            <div class="tp-result__big">${result.percent}%</div>
            <div class="tp-result__row">
                Правильных: <b>${result.correct_count}</b> из ${result.questions_count}
            </div>
            <div class="tp-result__row">
                Баллов: <b>${result.score}</b> из ${result.total_points}
            </div>
            ${result.pass_threshold != null
                ? `<div class="tp-result__row tp-result__row--muted">
                       Проходной балл: ${result.pass_threshold}%
                   </div>`
                : ''}
        `;
    }
    card.appendChild(node);
}


function pluralize(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
}

async function renderByStep(info, token) {
    if (info._expired) {
        renderTemplate('tpl-expired', {});
        return;
    }
    switch (info.next_step) {
        case 'register':
            renderTemplate('tpl-register', info);
            bindForm(token, info);
            break;
        case 'test':
            // Тест запускается автоматически — после регистрации сразу
            // грузим вопросы и рисуем форму прохождения.
            await renderTestStep(token, info);
            break;
        case 'completed': {
            // На completed-этапе у нас нет на руках score/percent — но статус
            // уже completed. Показываем заглушку без цифр.
            renderTemplate('tpl-completed', info);
            const card = document.getElementById('tp-card');
            const r = card.querySelector('[data-result]');
            if (r) r.textContent = 'Результаты переданы организатору.';
            break;
        }
        case 'expired':
        default:
            renderTemplate('tpl-expired', info);
            break;
    }
}

(async () => {
    const token = extractToken();
    if (!token) {
        showError('Неверная ссылка.');
        return;
    }
    try {
        const info = await loadInfo(token);
        renderByStep(info, token);
    } catch (e) {
        showError(e.message || 'Не удалось загрузить страницу.');
    }
})();
