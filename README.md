# Attic

Personal cloud storage that runs on your own PC. Open it from any browser, anywhere, without opening router ports. It needs only Node.js and has no other dependencies.

## Start

1. Double-click `start.bat`.
2. At `http://localhost:8420` on this PC, create the owner account. For safety this can only be done on the PC itself.
3. In **Settings**, turn on two-step sign-in.
4. In **Remote**, turn on one of the options below.

## Choosing where files live

By default files go in `data\storage` next to the app. To use another drive, copy `attic.config.example.json` to `attic.config.json` and set `storageDir`, then restart. Do this before uploading: Attic does not move existing files for you.

## Reaching it from anywhere

All three options use an outbound encrypted tunnel, so your home IP stays hidden.

| Option | Who can reach it | Address | Needs |
| --- | --- | --- | --- |
| Tailscale, private (most secure) | Only your own signed-in devices | Permanent | Tailscale app on each device |
| Tailscale Funnel, public | Anyone with the address reaches the sign-in page | Permanent | Funnel enabled on your Tailscale account |
| Cloudflare Quick Tunnel, public | Anyone with the address reaches the sign-in page | Changes on restart | `winget install Cloudflare.cloudflared` |

Tailscale's HTTPS and Funnel features may ask for a one-time approval. If so, Attic shows the link.

For a permanent address on your own domain, create a Cloudflare Tunnel that points at `http://127.0.0.1:8420`, then add this to `attic.config.json`:

```json
{ "cloudflareTunnelToken": "your-token", "publicHostname": "files.example.com" }
```

## Keeping it running

- Start with Windows: `powershell -ExecutionPolicy Bypass -File autostart.ps1` (add `-Remove` to undo).
- Stop the PC sleeping, or Attic goes offline: Settings > System > Power > Screen and sleep.
- It starts when you sign in to Windows, so after a reboot someone must sign in.

## What's protected, and what isn't

- Passwords are hashed with scrypt, sign-in attempts are rate limited, and two-step codes are single-use.
- Sessions are HttpOnly, SameSite=Strict cookies. Remote traffic is HTTPS through the tunnel.
- Uploaded files can't run scripts in the Attic page: only an allow-list of types displays in the browser, and HTML and SVG show as plain text.
- **Files are not encrypted on disk.** Anyone with access to this PC's drive can read them. Use BitLocker to protect against theft.
- **Attic is not a backup.** It keeps one copy, on one PC. Keep a separate backup of anything you can't lose.

## Locked out?

On the PC, run this. It prints a new password and turns off two-step sign-in:

```bash
node server.js reset yourusername
```

## Tests

```bash
npm test
```
