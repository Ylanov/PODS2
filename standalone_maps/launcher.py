# standalone_maps/launcher.py
"""
Оконный запуск «Карт» — без чёрной консоли.

Запускает локальный сервер в фоне, открывает карты в браузере и показывает
небольшое окно управления (открыть / ввести ключ Яндекса / выход). Именно этот
файл собирается в Karty.exe (PyInstaller --windowed).

Данные (БД, кеш, ключ) хранятся в %LOCALAPPDATA%\\Karty и сохраняются между
запусками — повторная установка после перезагрузки не нужна.
"""

import os
import socket
import sys
import threading
import webbrowser
import tkinter as tk
from tkinter import messagebox

import server
from server import app, DATA_DIR, PROVIDER

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8077"))
URL  = f"http://{HOST}:{PORT}"

_uv_server = None


def _port_busy(host: str, port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def _start_server():
    global _uv_server
    import uvicorn
    server._init_db()
    cfg = uvicorn.Config(app, host=HOST, port=PORT, log_level="warning")
    _uv_server = uvicorn.Server(cfg)
    _uv_server.install_signal_handlers = lambda: None   # не главный поток
    try:
        _uv_server.run()
    except Exception:
        pass


def _open():
    webbrowser.open(URL)


def _save_key(entry):
    key = entry.get().strip()
    if not key:
        messagebox.showinfo("Карты", "Введите ключ Яндекс.Карт.")
        return
    try:
        (DATA_DIR / "yandex.key").write_text(key + "\n", encoding="utf-8")
    except OSError as e:
        messagebox.showerror("Карты", f"Не удалось сохранить ключ:\n{e}")
        return
    messagebox.showinfo(
        "Карты",
        "Ключ Яндекс.Карт сохранён.\nЗакройте и запустите программу заново, чтобы он применился.",
    )


def main():
    # если сервер уже запущен (второй ярлык) — просто открыть браузер и выйти
    already = _port_busy(HOST, PORT)
    if not already:
        threading.Thread(target=_start_server, daemon=True).start()

    root = tk.Tk()
    root.title("Карты")
    root.geometry("440x340")
    root.resizable(False, False)
    try:
        ico = (getattr(sys, "_MEIPASS", None) and os.path.join(sys._MEIPASS, "karty.ico")) \
              or os.path.join(os.path.dirname(__file__), "karty.ico")
        if os.path.exists(ico):
            root.iconbitmap(ico)
    except Exception:
        pass

    pad = {"padx": 16, "pady": 6}
    tk.Label(root, text="Карты — зоны ответственности", font=("Segoe UI", 14, "bold")).pack(**pad)

    prov = "Яндекс.Карты" if PROVIDER == "yandex" else "OpenStreetMap"
    tk.Label(root, text=f"✅ Сервер работает: {URL}", font=("Segoe UI", 10)).pack(**pad)
    tk.Label(root, text=f"Подложка: {prov}", fg="#555", font=("Segoe UI", 9)).pack()

    tk.Button(root, text="🗺  Открыть карты", font=("Segoe UI", 12, "bold"),
              command=_open, height=2, width=24, bg="#1976d2", fg="white",
              activebackground="#1565c0", relief="flat").pack(pady=14)

    frm = tk.LabelFrame(root, text="Ключ Яндекс.Карт (необязательно)", padx=10, pady=8)
    frm.pack(fill="x", padx=16)
    entry = tk.Entry(frm, width=34)
    entry.pack(side="left", padx=(0, 8))
    tk.Button(frm, text="Сохранить", command=lambda: _save_key(entry)).pack(side="left")

    tk.Label(root, text="Окно можно свернуть. «Выход» останавливает сервер.",
             fg="#777", font=("Segoe UI", 8)).pack(pady=(10, 2))
    tk.Button(root, text="Выход", command=lambda: os._exit(0), width=12).pack(pady=4)

    root.after(1200, _open)
    root.protocol("WM_DELETE_WINDOW", lambda: os._exit(0))
    root.mainloop()
    os._exit(0)


if __name__ == "__main__":
    main()
