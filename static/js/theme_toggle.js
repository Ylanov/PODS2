// static/js/theme_toggle.js
//
// Переключатель тёмной/светлой темы.
//   • Атрибут data-theme на <html> применяет переопределения токенов из
//     tokens.css ([data-theme="dark"] { ... }). Все компоненты читают цвета
//     через var(--md-*), поэтому тема меняется одним атрибутом.
//   • Выбор сохраняется в localStorage. При первом заходе используется
//     системное предпочтение (prefers-color-scheme).
//   • Кнопка ставится в шапку приложения (#navbar) — рядом с другими.

const STORAGE_KEY = 'pods2_theme';   // 'light' | 'dark'

function _systemPrefersDark() {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

function _currentTheme() {
    return localStorage.getItem(STORAGE_KEY)
        || (_systemPrefersDark() ? 'dark' : 'light');
}

function _applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) {
        btn.textContent = theme === 'dark' ? '☀' : '☾';
        btn.title = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    }
}

export function initTheme() {
    // Применяем сразу — до отрисовки шапки. Кнопку ищем после; если её
    // ещё нет — повторим при initThemeToggleButton().
    _applyTheme(_currentTheme());
}

export function initThemeToggleButton() {
    // Если уже есть кнопка в HTML — используем её. Если нет — вставим
    // динамически в шапку слева от «Выйти» (или в конец #navbar).
    let btn = document.getElementById('theme-toggle-btn');
    if (!btn) {
        const navbar = document.getElementById('navbar');
        if (!navbar) return;
        btn = document.createElement('button');
        btn.id = 'theme-toggle-btn';
        btn.className = 'theme-toggle';
        btn.type = 'button';
        // Вставляем в .top-app-bar__inner перед последним child (Выйти).
        const inner = navbar.querySelector('.top-app-bar__inner') || navbar;
        inner.appendChild(btn);
    }
    btn.addEventListener('click', () => {
        const next = _currentTheme() === 'dark' ? 'light' : 'dark';
        localStorage.setItem(STORAGE_KEY, next);
        _applyTheme(next);
    });
    _applyTheme(_currentTheme());
}

// Применяем тему сразу при импорте — иначе при загрузке страницы пользователь
// увидит вспышку светлого фона перед тем, как JS вызовет initTheme().
initTheme();
