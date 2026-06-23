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
import shutil
import socket
import sys
import threading
import webbrowser
import tkinter as tk
from tkinter import filedialog, messagebox

import server
from server import app, DATA_DIR, DB_PATH, PROVIDER

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8077"))
URL  = f"http://{HOST}:{PORT}"

_uv_server = None
_start_error = None


def _ensure_streams():
    # PyInstaller --windowed: sys.stdout/stderr == None. uvicorn и logging падают
    # при попытке писать в None (поэтому при запуске ярлыком сервер не стартовал).
    # Перенаправляем в лог-файл (а если не вышло — в «никуда»).
    if sys.stdout and sys.stderr:
        return
    try:
        f = open(server.DATA_DIR / "karty.log", "a", encoding="utf-8", buffering=1)
    except Exception:
        f = open(os.devnull, "w")
    if not sys.stdout:
        sys.stdout = f
    if not sys.stderr:
        sys.stderr = f


def _port_busy(host: str, port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def _start_server():
    global _uv_server, _start_error
    try:
        import uvicorn
        server._init_db()
        # log_config=None — не даём uvicorn настраивать логирование через stdout,
        # access_log=False — меньше шума. Иначе в windowed-сборке падает на старте.
        cfg = uvicorn.Config(app, host=HOST, port=PORT, log_level="warning",
                             log_config=None, access_log=False)
        _uv_server = uvicorn.Server(cfg)
        _uv_server.install_signal_handlers = lambda: None   # не главный поток
        _uv_server.run()
    except Exception:
        import traceback
        _start_error = traceback.format_exc()
        try:
            print(_start_error, file=sys.stderr)
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


def _icon_path():
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
    p = os.path.join(base, "karty.ico")
    return p if os.path.exists(p) else None


def _open_folder():
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        os.startfile(str(DATA_DIR))          # Windows
    except Exception:
        try:
            import subprocess
            subprocess.Popen(["explorer", str(DATA_DIR)])
        except Exception as e:
            messagebox.showerror("Карты", f"Не удалось открыть папку:\n{e}")


def _backup():
    if not DB_PATH.exists():
        messagebox.showinfo("Карты", "Пока нет данных для резервной копии.")
        return
    dst = filedialog.asksaveasfilename(
        title="Сохранить резервную копию", defaultextension=".db",
        initialfile="karty_backup.db",
        filetypes=[("База данных Карт", "*.db"), ("Все файлы", "*.*")])
    if not dst:
        return
    try:
        shutil.copy(str(DB_PATH), dst)
        messagebox.showinfo("Карты", f"Резервная копия сохранена:\n{dst}")
    except Exception as e:
        messagebox.showerror("Карты", f"Не удалось сохранить копию:\n{e}")


def _restore():
    src = filedialog.askopenfilename(
        title="Выбрать резервную копию",
        filetypes=[("База данных Карт", "*.db"), ("Все файлы", "*.*")])
    if not src:
        return
    if not messagebox.askyesno(
            "Карты", "Восстановить из копии? Текущие зоны и базовая точка будут заменены."):
        return
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy(src, str(DB_PATH))
        messagebox.showinfo(
            "Карты", "Восстановлено. Закройте и запустите программу заново, чтобы применить.")
    except Exception as e:
        messagebox.showerror("Карты", f"Не удалось восстановить:\n{e}")


_tray = {"icon": None}


def _make_tray(root):
    """Значок в трее (если установлен pystray). При ошибке — None (окно работает как обычно)."""
    try:
        import pystray
        from PIL import Image
        ico = _icon_path()
        if not ico:
            return None
        image = Image.open(ico)

        def _show():
            root.after(0, lambda: (root.deiconify(), root.lift()))

        def _quit(icon=None, item=None):
            try:
                if _tray["icon"]:
                    _tray["icon"].stop()
            except Exception:
                pass
            os._exit(0)

        menu = pystray.Menu(
            pystray.MenuItem("Открыть карты", lambda i, it: _open(), default=True),
            pystray.MenuItem("Показать окно", lambda i, it: _show()),
            pystray.MenuItem("Выход", _quit),
        )
        return pystray.Icon("Karty", image, "Карты", menu)
    except Exception:
        return None


def main():
    _ensure_streams()
    # если сервер уже запущен (другой экземпляр) — не стартуем второй, просто откроем
    already = _port_busy(HOST, PORT)
    if not already:
        threading.Thread(target=_start_server, daemon=True).start()

    root = tk.Tk()
    root.title("Карты")
    root.geometry("460x420")
    root.resizable(False, False)
    ico = _icon_path()
    if ico:
        try:
            root.iconbitmap(ico)
        except Exception:
            pass

    pad = {"padx": 16, "pady": 6}
    tk.Label(root, text="Карты — зоны ответственности", font=("Segoe UI", 14, "bold")).pack(**pad)

    prov = "Яндекс.Карты" if PROVIDER == "yandex" else "OpenStreetMap"
    status_lbl = tk.Label(root, text="⏳ Запуск сервера…", font=("Segoe UI", 10))
    status_lbl.pack(**pad)
    tk.Label(root, text=f"Подложка: {prov}", fg="#555", font=("Segoe UI", 9)).pack()

    tk.Button(root, text="🗺  Открыть карты", font=("Segoe UI", 12, "bold"),
              command=_open, height=2, width=24, bg="#1976d2", fg="white",
              activebackground="#1565c0", relief="flat").pack(pady=14)

    frm = tk.LabelFrame(root, text="Ключ Яндекс.Карт (необязательно)", padx=10, pady=8)
    frm.pack(fill="x", padx=16)
    entry = tk.Entry(frm, width=34)
    entry.pack(side="left", padx=(0, 8))
    tk.Button(frm, text="Сохранить", command=lambda: _save_key(entry)).pack(side="left")

    row2 = tk.Frame(root)
    row2.pack(pady=(12, 2))
    tk.Button(row2, text="📂 Папка данных", command=_open_folder).pack(side="left", padx=4)
    tk.Button(row2, text="💾 Бэкап", command=_backup).pack(side="left", padx=4)
    tk.Button(row2, text="↩ Восстановить", command=_restore).pack(side="left", padx=4)

    hint = tk.Label(root, text="«Выход» останавливает сервер.", fg="#777", font=("Segoe UI", 8))
    hint.pack(pady=(10, 2))
    tk.Button(root, text="Выход", command=lambda: os._exit(0), width=12).pack(pady=4)

    # значок в трее (если доступен): крестик окна сворачивает в трей, а не закрывает
    tray = _make_tray(root)
    if tray:
        _tray["icon"] = tray
        threading.Thread(target=tray.run, daemon=True).start()
        hint.config(text="Крестик сворачивает в трей · «Выход» останавливает сервер.")

    def _on_close():
        if _tray["icon"]:
            root.withdraw()
        else:
            os._exit(0)

    _state = {"opened": False, "warned": False}

    def _check_up(tries=0):
        if _port_busy(HOST, PORT):
            status_lbl.config(text=f"✅ Сервер работает: {URL}", fg="#2e7d32")
            if not _state["opened"]:
                _state["opened"] = True
                _open()
            return
        if _start_error or tries >= 20:
            status_lbl.config(text="⚠ Сервер не запустился — см. karty.log", fg="#c0392b")
            if not _state["warned"]:
                _state["warned"] = True
                messagebox.showwarning(
                    "Карты",
                    "Не удалось запустить сервер.\nПодробности в файле:\n"
                    f"{server.DATA_DIR / 'karty.log'}",
                )
            return
        root.after(400, lambda: _check_up(tries + 1))

    root.after(500, _check_up)
    root.protocol("WM_DELETE_WINDOW", _on_close)
    root.mainloop()
    os._exit(0)


if __name__ == "__main__":
    main()
