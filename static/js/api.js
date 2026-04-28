// static/js/api.js

const BASE_URL = '/api/v1';

// Кастомный класс ошибки — несёт HTTP-статус вместе с сообщением.
// Это позволяет в catch-блоках различать 401/403 от сетевых ошибок:
//   catch(e) { if (e.status === 401) ... }
export class ApiError extends Error {
    constructor(message, status, detail = null) {
        super(message);
        this.name   = 'ApiError';
        this.status = status; // HTTP-статус ответа (400, 401, 403, 404, 500...)
        // detail — raw поле из тела ответа FastAPI. Может быть строкой,
        // объектом ({code, message, ...}) или массивом (validation errors).
        // Объектную форму использует, например, валидация интервала нарядов:
        // duty_too_close_warn / duty_too_close_strict.
        this.detail = detail;
    }
}

async function request(endpoint, options = {}) {
    const url   = `${BASE_URL}${endpoint}`;
    const token = localStorage.getItem('token');

    const headers = {
        'Content-Type': 'application/json',
        ...options.headers,
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    try {
        const response = await fetch(url, { ...options, headers });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: 'Unknown server error' }));

            // Если FastAPI вернул массив ошибок (например 422 ValidationError),
            // превращаем его в читаемый текст, чтобы не было [object Object].
            // Для object-detail ({code, message, ...}) сохраняем сам объект
            // в err.detail, а message берём из его поля .message.
            let errorMessage = errorData.detail;
            if (Array.isArray(errorMessage)) {
                errorMessage = errorMessage.map(e => `${e.loc.join('.')}: ${e.msg}`).join('\n');
            } else if (errorMessage && typeof errorMessage === 'object') {
                errorMessage = errorMessage.message || JSON.stringify(errorMessage);
            }

            // ApiError всегда несёт HTTP-статус — его можно проверить в catch.
            throw new ApiError(
                errorMessage || `HTTP error! status: ${response.status}`,
                response.status,
                errorData.detail,
            );
        }

        // Пустой ответ (204 No Content или пустое тело) — возвращаем success
        if (response.status === 204 || response.headers.get('content-length') === '0') {
            return { success: true };
        }

        return await response.json();

    } catch (error) {
        // Перебрасываем как есть — ApiError сохраняет status, сетевые ошибки
        // (TypeError: Failed to fetch) не имеют status и будут иметь status=undefined
        console.error(`API call failed: ${error.message}`);
        throw error;
    }
}

export const api = {
    get:    (endpoint)        => request(endpoint),
    post:   (endpoint, body)  => request(endpoint, { method: 'POST',   body: JSON.stringify(body) }),
    put:    (endpoint, body)  => request(endpoint, { method: 'PUT',    body: JSON.stringify(body) }),
    patch:  (endpoint, body)  => request(endpoint, { method: 'PATCH',  body: JSON.stringify(body) }),
    delete: (endpoint)        => request(endpoint, { method: 'DELETE' }),

    // НОВЫЙ МЕТОД: Загрузка файлов (multipart/form-data)
    upload: async (endpoint, formData) => {
        const url   = `${BASE_URL}${endpoint}`;
        const token = localStorage.getItem('token');

        // ВАЖНО: Мы не задаем 'Content-Type'. При отправке объекта FormData
        // браузер сам установит Content-Type: multipart/form-data; boundary=...
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: formData
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: 'Upload error' }));
            throw new ApiError(errorData.detail || 'Upload error', response.status);
        }

        return await response.json();
    },

    // Логин использует application/x-www-form-urlencoded — возвращает сырой Response
    login: (formData) => fetch(`${BASE_URL}/auth/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    formData,
    }),

    // Скачивание файла — возвращает Blob
    download: async (endpoint) => {
        const url     = `${BASE_URL}${endpoint}`;
        const token   = localStorage.getItem('token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        const response = await fetch(url, { headers });
        if (!response.ok) throw new ApiError('File download failed', response.status);

        return response.blob();
    },
};