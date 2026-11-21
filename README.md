<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/devin-logo-white.png" />
  <img src="assets/devin-logo.png" alt="devin-sub" width="96" />
</picture>

# devin-sub

**Your Devin subscription**, inside Pi.

[npm](https://www.npmjs.com/package/devin-sub) ·
[GitHub](https://github.com/sting-lon/devin-sub) ·
[Issues](https://github.com/sting-lon/devin-sub/issues)

</div>

<br />

## Install

```bash
pi install npm:devin-sub
```

## Login

```text
/login devin
```

The browser opens the Devin consent page. If the browser cannot reach the local
callback (SSH, container, blocked port), Pi asks you to paste the redirect URL
instead.

The token is stored in Pi's credential store. To replace it, run `/login devin`
again.

## Troubleshooting

- `/model` shows no `devin` entries: run `/login devin` first.
- Login page opens but nothing happens: paste the full redirect URL when Pi
  prompts for it.
- Requests fail with an authentication error: the token was revoked, run
  `/login devin` again.

## Uninstall

```bash
pi remove npm:devin-sub
```
