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
callback over SSH, inside a container, or behind a blocked port, Pi asks you to
paste the redirect URL instead.

Pi stores the token in its credential store. To replace the token, run
`/login devin` again.

## Troubleshooting

- If `/model` shows no `devin` entries, run `/login devin` first.
- If the login page opens and nothing happens, paste the full redirect URL when
  Pi prompts for it.
- If requests fail with an authentication error, Devin revoked the token. Run
  `/login devin` again.

## Uninstall

```bash
pi remove npm:devin-sub
```
