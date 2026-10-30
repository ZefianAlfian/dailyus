# DailyUs cloudflared tunnel — siap pakai di mesin dengan DNS normal

Akses publik: **https://dailyus.rizdev.ai.id** → aplikasi DailyUs di `127.0.0.1:7878`.

## Berkas
- `tunnel-token` — token JWT tunnel (chmod 600). Kunci rahasia — jangan commit.
- `config.yml` — konfigurasi ingress (hostname → port 7878).
- `start.sh` — jalankan tunnel (foreground, atau `--daemon`).

## Cara pakai (di mesin yang SUPPORT cloudflared)
```bash
cd ~/dailyus/cloudflared
./start.sh              # foreground
# atau
./start.sh --daemon     # background
```
Lalu buka https://dailyus.rizdev.ai.id

## CATATAN PENTING (status 2026-10-30)
VM/sandbox ini TIDAK bisa menjalankan cloudflared: resolver-nya memblokir
query DNS SRV yang dibutuhkan cloudflared untuk edge discovery, dan DoH
outbound juga diblokir. Jadi tunnel ini sengaja disiapkan untuk dijalankan di
host lain (VPS/laptop) yang memiliki DNS normal.

Cloudflare side sudah disetel lengkap:
- Tunnel: `dailyus` (id 231ea441-5f5d-4c1f-b435-cb325f230da2)
- DNS: `dailyus.rizdev.ai.id` → CNAME → `<tunnel-id>.cfargotunnel.com` (proxied)
- Ingress: remote config memetakan hostname ke http://127.0.0.1:7878

Dengan `--token` run, cloudflared memakai remote-managed config dari Cloudflare,
jadi `config.yml` di sini hanya cadangan/dokumentasi.

## Alternatif (kalau ingin Pages polling, cara 9router)
Worker Pages `dailyus-tunnel` sudah di-deploy + D1 + secrets, tapi ada
masalah edge: semua request ber-body (POST) hang di project itu (GET OK).
Project Pages baru juga hang semua method. Ini edge-level per project yang
tidak bisa diperbaiki dari sini — lihat skill `cloudflare-polling-tunnel`.

## Menyalakan DailyUs lokal
```bash
cd ~/dailyus && ./start.sh   # server di 127.0.0.1:7878
```
